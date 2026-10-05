/**
 * Live-memory bulk sampling engine.
 *
 * Two phases:
 *   1. prepare: resolve variable types/layouts once per unique type, root
 *      addresses and pointer dependencies from the Live GDB, then build a
 *      read plan that groups fields by their owning memory object.
 *   2. sample: read a few memory blocks per dependency level, decode all
 *      subscribed fields locally and update the variable cache. No per-field
 *      GDB evaluation happens on the steady-state path.
 *
 * Unsupported nodes (bitfields, unresolved layouts, missing addresses) are
 * routed to a compatibility list that is evaluated per frame.
 */
import { syntacticTypeKind, VariableObject } from './backend/backend';
import { MI2 } from './backend/mi2/mi2';
import {
    TypeResolver, TypeLayout, ScalarType, AggregateType,
    isAggregate, isScalar
} from './backend/live-memory-types';
import {
    AddressRegion, MemoryRange, mergeRanges, normalizeRegions, totalBytes, writableDataRegions
} from './backend/live-memory-plan';
import { GdbMemoryReader, MemoryReader } from './backend/live-memory-reader';
import { decodeScalarValue, decodePointerValue, DecodeBlock } from './backend/live-memory-decode';

export interface LiveSubscriptionNode {
    id: string;                     // gdb varobj name
    parent?: string;                // parent varobj name (absent for roots)
    kind: 'container' | 'deref';
    pointer?: string;               // for kind === 'deref': the pointer field node id
}

export interface LiveMemoryOptions {
    mode: 'auto' | 'legacy';
    maxBlockBytes: number;
    mergeGapBytes: number;
    maxDepth: number;
    extraRamRegions: AddressRegion[];
}

export interface LiveMemoryFrameValue {
    id: string;                     // gdb varobj name
    value?: string;
    status: 'ok' | 'unavailable';
    error?: string;
}

export interface LiveMemoryStats {
    phase: 'prepare' | 'sample' | 'legacy' | 'unsupported' | 'error';
    prepared: boolean;
    progressDone: number;
    progressTotal: number;
    requestedBytes: number;
    receivedBytes: number;
    blockCount: number;
    memoryReadCommands: number;
    memoryReadMs: number;
    msPerCommand: number;
    bytesPerCommand: number;
    commandLatenciesMs: number[];
    mergedGapBytes: number;
    fallbackFieldCount: number;
    fallbackMs: number;
    fallbackExamples: string[];
    subscribedFieldCount: number;
    successfulFieldCount: number;
    prepareMs: number;
    readMs: number;
    decodeMs: number;
    totalMs: number;
    errors: string[];
}

export interface LiveMemorySampleResult {
    values: LiveMemoryFrameValue[];
    stats: LiveMemoryStats;
    /** Set when the caller must use the legacy var-update path this cycle. */
    useLegacy: boolean;
}

interface VariableStore {
    variableHandlesReverse: Map<string, number>;
    variableHandles: { get(id: number): any };
    variableParents: Map<string, { parent: string; key: string }>;
}

interface PlannedField {
    nodeId: string;
    offset: number;
    byteSize: number;
    type: ScalarType;
    isPointer: boolean;
}

interface FallbackField {
    nodeId: string;
    expression?: string;
    reason: string;
}

interface OwnerPlan {
    ownerId: string;
    isRoot: boolean;
    level: number;
    supported: boolean;
    unsupportedReason?: string;
    byteSize: number;
    base?: { kind: 'fixed'; address: number };
    pointer?: { pointerNodeId: string; sourceOwnerId: string; offset: number; byteSize: number };
    fields: PlannedField[];
    fallback: FallbackField[];
    childOwnerIds: string[];
}

interface MemoryPlan {
    revision: number;
    owners: Map<string, OwnerPlan>;
    levels: OwnerPlan[][];
}

const PREPARE_BUDGET_MS = 200;
/** Above this many compatibility fields the legacy refresh is faster. */
const MAX_FALLBACK_FIELDS = 96;

function emptyStats(phase: LiveMemoryStats['phase']): LiveMemoryStats {
    return {
        phase,
        prepared: false,
        progressDone: 0,
        progressTotal: 0,
        requestedBytes: 0,
        receivedBytes: 0,
        blockCount: 0,
        memoryReadCommands: 0,
        memoryReadMs: 0,
        msPerCommand: 0,
        bytesPerCommand: 0,
        commandLatenciesMs: [],
        mergedGapBytes: 0,
        fallbackFieldCount: 0,
        fallbackMs: 0,
        fallbackExamples: [],
        subscribedFieldCount: 0,
        successfulFieldCount: 0,
        prepareMs: 0,
        readMs: 0,
        decodeMs: 0,
        totalMs: 0,
        errors: []
    };
}

/**
 * Resolves a child-key path (member names and array indexes) through a type
 * layout. Multi-dimensional arrays use the correct stride per index. Returns
 * undefined when the path cannot be trusted.
 */
export function resolveMemberPath(
    root: AggregateType,
    path: string[]
): {
    offset: number;
    byteSize: number;
    type: TypeLayout;
    bitfield?: { bitOffset: number; bitSize: number };
    container?: boolean;
} | undefined {
    let current: TypeLayout = root;
    let base = 0;
    let array: { elem: TypeLayout; elemSize: number; dims: number[]; index: number; base: number } | undefined;

    for (const key of path) {
        if (/^\d+$/.test(key)) {
            if (!array) { return undefined; }
            const index = parseInt(key, 10);
            const dimension = array.dims[array.index];
            if (dimension === undefined || index < 0 || index >= dimension) { return undefined; }
            const remaining = array.dims.slice(array.index + 1);
            const remainingCount = remaining.length > 0
                ? remaining.reduce((left, right) => left * right, 1)
                : 1;
            const stride = array.elemSize * remainingCount;
            array.base = array.base + index * stride;
            array.index++;
            base = array.base;
            current = array.elem;
            continue;
        }
        if (!isAggregate(current)) { return undefined; }
        const member = current.members.find((candidate) => candidate.name === key);
        if (!member || member.anonymous) { return undefined; }
        base += member.byteOffset;
        current = member.type;
        if (member.arrayDims && member.arrayDims.length > 0) {
            const count = member.arrayDims.reduce((left, right) => left * right, 1);
            const elemSize = count > 0 ? member.byteSize / count : 0;
            if (elemSize <= 0) { return undefined; }
            array = { elem: member.type, elemSize, dims: member.arrayDims, index: 0, base };
        } else {
            array = undefined;
        }
        if (member.bitfield) {
            return { offset: base, byteSize: member.byteSize, type: current, bitfield: member.bitfield };
        }
    }
    if (array && array.index < array.dims.length) {
        const remainingCount = array.dims.slice(array.index).reduce((left, right) => left * right, 1);
        return {
            offset: array.base,
            byteSize: array.elemSize * remainingCount,
            type: array.elem,
            container: true
        };
    }
    if (isAggregate(current)) {
        return { offset: base, byteSize: current.byteSize, type: current, container: true };
    }
    const layout = current as TypeLayout;
    if (isScalar(layout)) {
        return { offset: base, byteSize: layout.byteSize, type: layout };
    }
    return undefined;
}

export class LiveMemoryEngine {
    private readonly resolver: TypeResolver;
    private readonly reader: MemoryReader;
    private regions: AddressRegion[] | undefined;
    private revision = -1;
    private nodes: LiveSubscriptionNode[] = [];
    private nodeById = new Map<string, LiveSubscriptionNode>();
    private ownerCache = new Map<string, string>();
    private plan?: MemoryPlan;
    private prepared = false;
    private prepareIndex = 0;
    private readonly ownerQueue: string[] = [];
    private prepareStartedAt = 0;
    private lastSummaryRevision = -1;

    constructor(
        private readonly store: VariableStore,
        private readonly mi: MI2,
        private readonly getOptions: () => LiveMemoryOptions,
        resolver?: TypeResolver
    ) {
        this.resolver = resolver || new TypeResolver({
            console: (command) => mi.sendCliCommand(command),
            evaluate: (expression) => mi.evaluateNumber(expression)
        });
        this.reader = new GdbMemoryReader({
            readMemoryRange: (address, length) => mi.readMemoryRange(address, length)
        });
    }

    public clear(): void {
        this.revision = -1;
        this.nodes = [];
        this.nodeById.clear();
        this.ownerCache.clear();
        this.plan = undefined;
        this.prepared = false;
        this.prepareIndex = 0;
        this.ownerQueue.length = 0;
        this.regions = undefined;
        this.resolver.clear();
    }

    public setSubscription(revision: number, nodes: LiveSubscriptionNode[]): void {
        if (this.revision === revision) { return; }
        this.revision = revision;
        this.nodes = nodes;
        this.nodeById = new Map(nodes.map((node) => [node.id, node]));
        this.ownerCache.clear();
        this.plan = undefined;
        this.prepared = false;
        this.prepareIndex = 0;
        this.ownerQueue.length = 0;
        // ELF sections are stable for this session. Discovering another child
        // must not repeat this GDB query on every subscription revision.
    }

    public getRevision(): number { return this.revision; }

    public async sample(): Promise<LiveMemorySampleResult> {
        const options = this.getOptions();
        if (options.mode === 'legacy') {
            return { values: [], stats: emptyStats('legacy'), useLegacy: true };
        }
        if (this.revision < 0 || this.nodes.length === 0) {
            return { values: [], stats: emptyStats('legacy'), useLegacy: true };
        }
        const started = Date.now();
        try {
            await this.ensureRegions();
            if (!this.regions || this.regions.length === 0) {
                const stats = emptyStats('unsupported');
                stats.errors.push('未识别到普通 RAM 区间，回退逐字段读取');
                return { values: [], stats, useLegacy: true };
            }
            if (!this.prepared) {
                const prepared = await this.prepareStep(options);
                if (!prepared) {
                    const stats = emptyStats('prepare');
                    stats.progressDone = this.prepareIndex;
                    stats.progressTotal = this.prepareTotal();
                    stats.prepareMs = Date.now() - this.prepareStartedAt;
                    stats.totalMs = Date.now() - started;
                    return { values: [], stats, useLegacy: false };
                }
                this.prepared = true;
            }
            const supportedOwners = this.plan.levels.reduce((count, level) => count + level.length, 0);
            const fallbackFields = this.countFallbackFields();
            if (supportedOwners === 0 || fallbackFields > MAX_FALLBACK_FIELDS) {
                // The per-field compatibility path must never be slower than the
                // legacy var-update refresh; hand the whole frame back instead.
                const stats = emptyStats('unsupported');
                stats.prepared = true;
                stats.progressDone = this.prepareIndex;
                stats.progressTotal = this.prepareTotal();
                stats.fallbackFieldCount = fallbackFields;
                stats.errors.push(
                    `批量计划未生效（可用对象 ${supportedOwners} 个，兼容字段 ${fallbackFields} 个），改用逐字段模式`);
                let reported = 0;
                for (const owner of this.plan.owners.values()) {
                    if (owner.supported || !owner.unsupportedReason || reported >= 3) { continue; }
                    stats.errors.push(`对象 ${this.describe(owner.ownerId)}：${owner.unsupportedReason}`);
                    reported++;
                }
                stats.totalMs = Date.now() - started;
                return { values: [], stats, useLegacy: true };
            }
            return await this.samplePlan(this.plan, options, started);
        } catch (error) {
            const stats = emptyStats('error');
            stats.errors.push(error instanceof Error ? error.message : String(error));
            stats.totalMs = Date.now() - started;
            return { values: [], stats, useLegacy: true };
        }
    }

    private prepareTotal(): number {
        return Math.max(1, this.ownerQueue.length);
    }

    private async ensureRegions(): Promise<void> {
        if (this.regions !== undefined) { return; }
        let regions: AddressRegion[] = [];
        try {
            const output = await this.mi.sendCliCommand('maintenance info sections');
            regions = writableDataRegions(output);
        } catch (_error) { /* fall back to user regions only */ }
        this.regions = normalizeRegions(regions.concat(this.getOptions().extraRamRegions || []));
    }

    /* ------------------------------------------------------------------ */
    /* Prepare                                                             */
    /* ------------------------------------------------------------------ */

    private async prepareStep(options: LiveMemoryOptions): Promise<boolean> {
        const prepareStart = Date.now();
        if (this.prepareIndex === 0) {
            this.prepareStartedAt = prepareStart;
            this.buildOwnerQueue();
        }
        if (this.ownerQueue.length === 0) {
            this.plan = { revision: this.revision, owners: new Map(), levels: [] };
            return true;
        }
        if (!this.plan) {
            this.plan = { revision: this.revision, owners: new Map(), levels: [] };
        }
        const plan = this.plan;
        while (this.prepareIndex < this.ownerQueue.length && (Date.now() - prepareStart) < PREPARE_BUDGET_MS) {
            const ownerId = this.ownerQueue[this.prepareIndex];
            await this.prepareOwner(ownerId, plan, options);
            this.prepareIndex++;
        }
        if (this.prepareIndex < this.ownerQueue.length) { return false; }
        this.assignLevels(plan, options);
        return true;
    }

    private buildOwnerQueue(): void {
        this.ownerQueue.length = 0;
        const seen = new Set<string>();
        for (const node of this.nodes) {
            const ownerId = this.ownerOf(node.id);
            if (!seen.has(ownerId)) {
                seen.add(ownerId);
                this.ownerQueue.push(ownerId);
            }
        }
    }

    /** Nearest root/deref ancestor (or the node itself) for a subscription id. */
    public ownerOf(nodeId: string): string {
        const cached = this.ownerCache.get(nodeId);
        if (cached !== undefined) { return cached; }
        let current = nodeId;
        let result = nodeId;
        const visited = new Set<string>();
        for (let depth = 0; depth < 64; depth++) {
            if (visited.has(current)) { break; }
            visited.add(current);
            const node = this.nodeById.get(current);
            if (node) {
                if (node.kind === 'deref') {
                    result = current;
                    break;
                }
                if (!node.parent) {
                    result = current;
                    break;
                }
                const parentNode = this.nodeById.get(node.parent);
                if (!parentNode) {
                    const parentInfo = this.store.variableParents.get(current);
                    if (!parentInfo) {
                        result = current;
                        break;
                    }
                    current = parentInfo.parent;
                    continue;
                }
                current = node.parent;
                continue;
            }
            const parentInfo = this.store.variableParents.get(current);
            if (!parentInfo) {
                result = current;
                break;
            }
            current = parentInfo.parent;
        }
        // The owner must be a subscription node (root or deref); if the walk
        // ended on a non-subscribed node, sample that node as its own object.
        this.ownerCache.set(nodeId, result);
        return result;
    }

    private async prepareOwner(ownerId: string, plan: MemoryPlan, options: LiveMemoryOptions): Promise<void> {
        if (plan.owners.has(ownerId)) { return; }
        const variable = this.lookup(ownerId);
        const subscription = this.nodeById.get(ownerId);
        const isDeref = subscription?.kind === 'deref';
        const owner: OwnerPlan = {
            ownerId, isRoot: !isDeref, level: -1, supported: false, byteSize: 0,
            fields: [], fallback: [], childOwnerIds: []
        };
        plan.owners.set(ownerId, owner);
        if (!variable) {
            owner.unsupportedReason = '变量对象不存在';
            await this.fallbackUnderOwner(owner);
            return;
        }

        const rawType = String(variable.type || '');
        const fieldNodes = this.nodes.filter((node) => node.id !== ownerId
            && this.ownerOf(node.id) === ownerId && !this.isContainerVariable(node.id));
        const paths = fieldNodes.map((node) => this.memberPath(ownerId, node.id)).filter((path) => !!path);
        const layout = await this.resolver.resolveTypeText(rawType, paths);
        if (!layout) {
            owner.unsupportedReason = `无法解析对象布局：${rawType || '<unknown>'}`;
            await this.fallbackUnderOwner(owner);
            return;
        }

        // Scalar (and pointer) roots/deref targets sample their own value.
        if (isScalar(layout)) {
            owner.byteSize = layout.byteSize;
            owner.fields.push({
                nodeId: ownerId,
                offset: 0,
                byteSize: layout.byteSize,
                type: layout,
                isPointer: layout.kind === 'pointer' || layout.kind === 'function-pointer'
            });
            if (!isDeref) {
                const resolvedAddress = await this.rootAddress(ownerId);
                if (resolvedAddress.address === undefined) {
                    owner.unsupportedReason = `根对象没有固定地址：${resolvedAddress.error || ''}`;
                    owner.fields = [];
                    await this.fallbackUnderOwner(owner);
                    return;
                }
                owner.base = { kind: 'fixed', address: resolvedAddress.address };
            } else {
                const pointerId = subscription?.pointer;
                if (!pointerId) {
                    owner.unsupportedReason = '解引用节点缺少指针来源';
                    owner.fields = [];
                    await this.fallbackUnderOwner(owner);
                    return;
                }
                owner.pointer = { pointerNodeId: pointerId, sourceOwnerId: '', offset: 0, byteSize: 0 };
            }
            owner.supported = true;
            return;
        }

        if (!isAggregate(layout)) {
            owner.unsupportedReason = `不支持的布局：${rawType}`;
            await this.fallbackUnderOwner(owner);
            return;
        }
        owner.byteSize = layout.byteSize;

        if (isDeref) {
            const pointerId = subscription?.pointer;
            if (!pointerId) {
                owner.unsupportedReason = '解引用节点缺少指针来源';
                await this.fallbackUnderOwner(owner);
                return;
            }
            owner.pointer = { pointerNodeId: pointerId, sourceOwnerId: '', offset: 0, byteSize: 0 };
        } else {
            const resolvedAddress = await this.rootAddress(ownerId);
            if (resolvedAddress.address === undefined) {
                owner.unsupportedReason = `根对象没有固定地址：${resolvedAddress.error || ''}`;
                await this.fallbackUnderOwner(owner);
                return;
            }
            owner.base = { kind: 'fixed', address: resolvedAddress.address };
        }

        for (const node of fieldNodes) {
            await this.prepareField(node.id, owner, layout);
        }
        owner.supported = owner.fields.length > 0;
    }

    private async rootAddress(ownerId: string): Promise<{ address?: number; error?: string }> {
        const pathExpression = await this.mi.varInfoPathExpression(ownerId);
        if (!pathExpression) { return { error: '无法取得路径表达式' }; }
        const addressText = await this.mi.evaluateNumber(`(unsigned long)&(${pathExpression})`);
        const address = parseAddress(addressText);
        if (address === undefined) {
            return { error: `地址解析失败：${addressText.slice(0, 40) || '<空>'}` };
        }
        return { address };
    }

    private countFallbackFields(): number {
        if (!this.plan) { return 0; }
        let count = 0;
        for (const owner of this.plan.owners.values()) {
            count += owner.fallback.length;
        }
        return count;
    }

    private describe(nodeId: string): string {
        const variable = this.lookup(nodeId);
        return variable?.exp || nodeId;
    }

    private async fallbackUnderOwner(owner: OwnerPlan): Promise<void> {
        const reason = owner.unsupportedReason || '回退';
        for (const node of this.nodes) {
            if (node.id === owner.ownerId) {
                if (node.kind === 'container') {
                    await this.queueFallback(owner, node.id, reason);
                }
                continue;
            }
            if (this.ownerOf(node.id) === owner.ownerId) {
                await this.queueFallback(owner, node.id, reason);
            }
        }
        owner.supported = false;    // fallback-only owner: no bulk reads
    }

    private isContainerVariable(nodeId: string): boolean {
        const variable = this.lookup(nodeId);
        if (!variable) { return true; }
        const kind = variable.typeKind || syntacticTypeKind(variable.type);
        if (kind === 'struct' || kind === 'union' || kind === 'array' || kind === 'aggregate') { return true; }
        const pointer = kind === 'pointer' || kind === 'function-pointer'
            || ((kind === 'typedef' || kind === 'unknown') && /^0x[0-9a-f]+/i.test(variable.value || ''));
        return variable.numchild > 0 && !pointer;
    }

    private async queueFallback(owner: OwnerPlan, nodeId: string, reason: string): Promise<void> {
        if (this.isContainerVariable(nodeId)) { return; }
        const variable = this.lookup(nodeId);
        if (variable) {
            try {
                const kind = await this.resolver.classifyTypeText(String(variable.type || ''));
                if (kind === 'struct' || kind === 'union' || kind === 'array') { return; }
            } catch (_error) {
                // Keep a scalar compatibility read available if type metadata fails.
            }
        }
        if (!owner.fallback.some((fallback) => fallback.nodeId === nodeId)) {
            owner.fallback.push({ nodeId, reason });
        }
    }

    private async prepareField(nodeId: string, owner: OwnerPlan, layout: AggregateType): Promise<void> {
        const variable = this.lookup(nodeId);
        if (!variable) {
            await this.queueFallback(owner, nodeId, '变量对象不存在');
            return;
        }
        const path = this.memberPath(owner.ownerId, nodeId);
        if (!path || path.length === 0) {
            await this.queueFallback(owner, nodeId, '无法确定字段路径');
            return;
        }
        const resolved = resolveMemberPath(layout, path);
        if (!resolved) {
            await this.queueFallback(owner, nodeId, '无法由类型布局映射字段');
            return;
        }
        if (resolved.container || !isScalar(resolved.type)) {
            return; // aggregate and array nodes are UI containers, not sampled values
        }
        if (this.isContainerVariable(nodeId)) {
            return;
        }
        if (resolved.bitfield) {
            await this.queueFallback(owner, nodeId, '位域暂不支持批量解码');
            return;
        }
        if (resolved.offset < 0 || resolved.offset + resolved.byteSize > owner.byteSize) {
            await this.queueFallback(owner, nodeId, '字段超出对象范围');
            return;
        }
        const scalar = resolved.type;
        owner.fields.push({
            nodeId,
            offset: resolved.offset,
            byteSize: scalar.byteSize,
            type: scalar,
            isPointer: scalar.kind === 'pointer' || scalar.kind === 'function-pointer'
        });
    }

    /** Member key path from an owner to a descendant node. */
    private memberPath(ownerId: string, nodeId: string): string[] | undefined {
        const keys: string[] = [];
        let current = nodeId;
        for (let depth = 0; depth < 64; depth++) {
            if (current === ownerId) { return keys.reverse(); }
            const info = this.store.variableParents.get(current);
            if (!info) { return undefined; }
            keys.push(info.key);
            current = info.parent;
        }
        return undefined;
    }

    private assignLevels(plan: MemoryPlan, options: LiveMemoryOptions): void {
        // Resolve pointer dependencies between owners.
        for (const owner of plan.owners.values()) {
            if (!owner.pointer) { continue; }
            const pointerVariable = owner.pointer;
            const sourceOwnerId = this.ownerOf(pointerVariable.pointerNodeId);
            const sourceOwner = plan.owners.get(sourceOwnerId);
            if (!sourceOwner || !sourceOwner.supported) {
                owner.supported = false;
                owner.unsupportedReason = '指针来源对象不可用';
                continue;
            }
            const field = sourceOwner.fields.find((candidate) => candidate.nodeId === pointerVariable.pointerNodeId);
            if (!field || !field.isPointer) {
                owner.supported = false;
                owner.unsupportedReason = '指针字段不在采样计划中';
                continue;
            }
            pointerVariable.sourceOwnerId = sourceOwnerId;
            pointerVariable.offset = field.offset;
            pointerVariable.byteSize = field.byteSize;
            sourceOwner.childOwnerIds.push(owner.ownerId);
        }

        // Levels: fixed owners first, then pointer depth. Pointer cycles keep
        // the already assigned lower level and are cut off by maxDepth.
        const levelOf = new Map<string, number>();
        for (const owner of plan.owners.values()) {
            if (owner.supported && owner.isRoot) { levelOf.set(owner.ownerId, 0); }
        }
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 64) {
            changed = false;
            for (const owner of plan.owners.values()) {
                if (!owner.supported || !owner.pointer) { continue; }
                const parentLevel = levelOf.get(owner.pointer.sourceOwnerId);
                if (parentLevel === undefined) { continue; }
                const next = parentLevel + 1;
                const current = levelOf.get(owner.ownerId);
                if (current === undefined || current < next) {
                    levelOf.set(owner.ownerId, next);
                    changed = true;
                }
            }
        }
        const levels: OwnerPlan[][] = [];
        for (const owner of plan.owners.values()) {
            if (!owner.supported) { continue; }
            const level = levelOf.get(owner.ownerId);
            if (level === undefined) {
                owner.supported = false;
                owner.unsupportedReason = '指针依赖链无法解析，按兼容读取';
                continue;
            }
            if (level > options.maxDepth) {
                owner.supported = false;
                owner.unsupportedReason = `超过最大解引用深度 ${options.maxDepth}，按兼容读取`;
                continue;
            }
            owner.level = level;
            while (levels.length <= level) {
                levels.push([]);
            }
            levels[level].push(owner);
        }
        plan.levels = levels;

        // Owners that lost support after dependency analysis go to fallback.
        for (const owner of plan.owners.values()) {
            if (owner.supported) { continue; }
            for (const field of owner.fields) {
                owner.fallback.push({ nodeId: field.nodeId, reason: owner.unsupportedReason || '回退' });
            }
            owner.fields = [];
            if (owner.base || owner.pointer) {
                for (const node of this.nodes) {
                    if (node.id === owner.ownerId || this.ownerOf(node.id) !== owner.ownerId) { continue; }
                    if (this.isContainerVariable(node.id)) { continue; }
                    if (!owner.fallback.some((fallback) => fallback.nodeId === node.id)) {
                        owner.fallback.push({ nodeId: node.id, reason: owner.unsupportedReason || '回退' });
                    }
                }
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Sample                                                              */
    /* ------------------------------------------------------------------ */

    private async samplePlan(plan: MemoryPlan, options: LiveMemoryOptions, started: number): Promise<LiveMemorySampleResult> {
        const stats = emptyStats('sample');
        stats.prepared = true;
        stats.progressDone = this.prepareIndex;
        stats.progressTotal = this.prepareTotal();
        const values: LiveMemoryFrameValue[] = [];
        const pointerValues = new Map<string, number>();
        const unavailableOwners = new Map<string, string>();
        const readBlocks: DecodeBlock[] = [];
        const readStart = Date.now();
        let requestedBytes = 0;
        let mergedGapBytes = 0;
        // Fixed block size: shrinking blocks on a high-latency link only adds
        // round trips (commands = ceil(bytes/block)) and can spiral downward
        // until every object is split across commands.
        const blockLimit = Math.max(256, options.maxBlockBytes);

        for (const level of plan.levels) {
            const requests: { owner: OwnerPlan; field: PlannedField; range: MemoryRange }[] = [];
            for (const owner of level) {
                if (unavailableOwners.has(owner.ownerId)) { continue; }
                let base: number | undefined;
                if (owner.base) {
                    base = owner.base.address;
                } else if (owner.pointer) {
                    const target = pointerValues.get(owner.pointer.pointerNodeId);
                    if (target === undefined) {
                        unavailableOwners.set(owner.ownerId, `指针 ${owner.pointer.pointerNodeId} 未采样`);
                        continue;
                    }
                    if (target === 0) {
                        unavailableOwners.set(owner.ownerId, '空指针');
                        continue;
                    }
                    base = target;
                }
                if (base === undefined) { continue; }
                for (const field of owner.fields) {
                    requests.push({ owner, field, range: { address: base + field.offset, length: field.byteSize } });
                }
            }
            if (requests.length === 0) { continue; }

            const merged = mergeRanges(requests.map((request) => request.range), {
                maxBlockBytes: blockLimit,
                maxGapBytes: options.mergeGapBytes,
                regions: this.regions
            });
            requestedBytes += totalBytes(merged.blocks);
            stats.blockCount += merged.blocks.length;
            stats.memoryReadCommands += merged.blocks.length;
            const ordered = merged.blocks.slice().sort((a, b) => a.address - b.address);
            for (let i = 1; i < ordered.length; i++) {
                const gap = ordered[i].address - (ordered[i - 1].address + ordered[i - 1].length);
                if (gap > 0) { mergedGapBytes += gap; }
            }

            const results = await this.reader.readRanges(merged.blocks);
            for (const result of results) {
                stats.commandLatenciesMs.push(Math.round(result.elapsedMs));
                stats.memoryReadMs += result.elapsedMs;
                if (result.data) {
                    readBlocks.push({ address: result.range.address, data: result.data });
                    stats.receivedBytes += result.data.length;
                } else if (result.error && stats.errors.length < 8) {
                    stats.errors.push(`读取 0x${result.range.address.toString(16)} ${result.range.length}B：${result.error}`);
                }
            }

            const decodeStart = Date.now();
            for (const request of requests) {
                const { owner, field, range } = request;
                if (unavailableOwners.has(owner.ownerId)) { continue; }
                const rejected = merged.rejected.some((item) => item.address === range.address && item.length === range.length);
                if (rejected) {
                    values.push({ id: field.nodeId, status: 'unavailable', error: '地址不在已确认的 RAM 区间内' });
                    continue;
                }
                const block = this.findCoveringBlock(readBlocks, range.address, range.length);
                if (!block) {
                    values.push({ id: field.nodeId, status: 'unavailable', error: '内存块读取失败' });
                    continue;
                }
                const offset = range.address - block.address;
                const decoded = decodeScalarValue(block.data, offset, field.type, 'little');
                if (decoded === undefined) {
                    values.push({ id: field.nodeId, status: 'unavailable', error: '解码失败' });
                    continue;
                }
                values.push({ id: field.nodeId, status: 'ok', value: decoded });
                const variable = this.lookup(field.nodeId);
                if (variable) { variable.value = decoded; }
                if (field.isPointer) {
                    const pointer = decodePointerValue(block.data, offset, field.byteSize, 'little');
                    if (pointer !== undefined) { pointerValues.set(field.nodeId, pointer); }
                }
            }
            stats.decodeMs += Date.now() - decodeStart;
        }

        // Owners that failed this frame: mark every planned field unavailable.
        for (const owner of plan.owners.values()) {
            const reason = unavailableOwners.get(owner.ownerId);
            if (!reason) { continue; }
            for (const field of owner.fields) {
                values.push({ id: field.nodeId, status: 'unavailable', error: reason });
            }
            if (owner.base || owner.pointer) {
                for (const node of this.nodes) {
                    if (node.id === owner.ownerId || this.ownerOf(node.id) !== owner.ownerId) { continue; }
                    if (!values.some((value) => value.id === node.id)
                        && !owner.fallback.some((fallback) => fallback.nodeId === node.id)) {
                        values.push({ id: node.id, status: 'unavailable', error: reason });
                    }
                }
            }
        }

        // Compatibility fields only; the bulk path never calls var-update.
        const fallbackFields: FallbackField[] = [];
        for (const owner of plan.owners.values()) {
            fallbackFields.push(...owner.fallback);
        }
        stats.fallbackFieldCount = fallbackFields.length;
        stats.fallbackExamples = fallbackFields.slice(0, 8)
            .map((field) => `${field.nodeId}: ${field.reason}`);
        const fallbackStart = Date.now();
        for (const fallback of fallbackFields) {
            if (!fallback.expression) {
                fallback.expression = await this.mi.varInfoPathExpression(fallback.nodeId) || '';
            }
            if (!fallback.expression) {
                values.push({ id: fallback.nodeId, status: 'unavailable', error: fallback.reason });
                continue;
            }
            const text = await this.mi.evaluateNumber(fallback.expression);
            if (text === '') {
                values.push({ id: fallback.nodeId, status: 'unavailable', error: fallback.reason });
            } else {
                values.push({ id: fallback.nodeId, status: 'ok', value: text });
                const variable = this.lookup(fallback.nodeId);
                if (variable) { variable.value = text; }
            }
        }
        stats.fallbackMs = Date.now() - fallbackStart;

        stats.subscribedFieldCount = this.nodes.length;
        stats.successfulFieldCount = values.filter((value) => value.status === 'ok').length;
        stats.readMs = Date.now() - readStart;
        stats.requestedBytes = requestedBytes;
        stats.mergedGapBytes = mergedGapBytes;
        if (stats.commandLatenciesMs.length > 0) {
            stats.msPerCommand = stats.commandLatenciesMs.reduce((a, b) => a + b, 0) / stats.commandLatenciesMs.length;
            stats.bytesPerCommand = stats.receivedBytes / stats.commandLatenciesMs.length;
        }
        stats.totalMs = Date.now() - started;
        if (this.lastSummaryRevision !== plan.revision) {
            this.lastSummaryRevision = plan.revision;
            let lines = 0;
            for (const owner of plan.owners.values()) {
                if (lines >= 12) { break; }
                const variable = this.lookup(owner.ownerId);
                const name = variable?.exp || owner.ownerId;
                if (owner.supported) {
                    const base = owner.base
                        ? `0x${owner.base.address.toString(16)}`
                        : `指针<${owner.pointer ? owner.pointer.pointerNodeId : '?'}>`;
                    stats.errors.push(
                        `批量对象 ${name}：基址 ${base} · ${owner.byteSize}B · 字段 ${owner.fields.length}`
                        + (owner.fallback.length ? ` · 兼容 ${owner.fallback.length}` : ''));
                    lines++;
                } else if (owner.unsupportedReason) {
                    stats.errors.push(`回退对象 ${name}：${owner.unsupportedReason}`);
                    lines++;
                }
            }
        }
        return { values, stats, useLegacy: false };
    }

    private findCoveringBlock(blocks: DecodeBlock[], address: number, length: number): DecodeBlock | undefined {
        const end = address + length;
        const candidates = blocks
            .filter((block) => block.address < end && block.address + block.data.length > address)
            .sort((left, right) => left.address - right.address);
        const data = Buffer.alloc(length);
        let cursor = address;
        for (const block of candidates) {
            const blockEnd = block.address + block.data.length;
            if (blockEnd <= cursor) { continue; }
            if (block.address > cursor) { return undefined; }
            const copyEnd = Math.min(end, blockEnd);
            const sourceStart = cursor - block.address;
            const destinationStart = cursor - address;
            block.data.copy(data, destinationStart, sourceStart, sourceStart + copyEnd - cursor);
            cursor = copyEnd;
            if (cursor === end) { return { address, data }; }
        }
        return undefined;
    }

    private lookup(name: string): VariableObject | undefined {
        const handle = this.store.variableHandlesReverse.get(name);
        if (handle === undefined) { return undefined; }
        const variable = this.store.variableHandles.get(handle);
        return variable instanceof VariableObject ? variable : undefined;
    }
}

function parseAddress(text: string): number | undefined {
    const hex = /0x[0-9a-fA-F]+/.exec(text);
    if (hex) {
        const value = parseInt(hex[0], 16);
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }
    // GDB prints `(unsigned long)` values in the current output radix, so a
    // decimal setting yields a plain decimal number instead of 0x...
    const decimal = /(?:^|[^\w])(\d+)(?:[^\w]|$)/.exec(text);
    if (decimal) {
        const value = parseInt(decimal[1], 10);
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }
    return undefined;
}
