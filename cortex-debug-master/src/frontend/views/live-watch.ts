import { TreeItem, TreeDataProvider, EventEmitter, Event, TreeItemCollapsibleState, ProviderResult } from 'vscode';
import * as vscode from 'vscode';

import { getPathRelative, LiveWatchConfig } from '../../common';
import { BaseNode } from './nodes/basenode';
import { DebugProtocol } from '@vscode/debugprotocol';
import { SymbolInformation } from '../../symbols';
import { shouldTraverseLiveChildren } from './live-watch-traversal';
import { LiveWriteResult } from '../../backend/live-watch-write';
import { LiveDisplayMode, LiveMatrixRequest, LiveMatrixSample, LiveMatrixShape, validMatrixShape } from '../../live-matrix';

export interface LivePlotSample {
    sessionId: string;
    timestampMs: number;
    actualHz: number | undefined;
    values: Record<string, number | null>;
}

export interface LivePlotStatus {
    sessionId: string;
    status: 'running' | 'stopped' | 'terminated';
}

export interface LiveValueRow {
    path: string;
    label: string;
    value: string;
    changed: boolean;
    depth: number;
    expandable: boolean;
    expanded: boolean;
    root: boolean;
    monitorAll: boolean;
    hasMore: boolean;
    tooltip: string;
    functionTarget: string;
    plottable: boolean;
    editable: boolean;
    displayMode?: LiveDisplayMode;
    matrixShape?: LiveMatrixShape;
    matrix?: { rows: number; columns: number; values: string[]; changed: boolean[]; error?: string; timestampMs?: number };
}

export interface LiveValuesSample {
    sessionId: string;
    timestampMs: number;
    targetHz: number;
    actualHz: number | undefined;
    rows: LiveValueRow[];
}

export interface PinnedLocalInfo {
    address: string;
    functionName: string;
    sourceFile: string;
    sourceExpression: string;
}

interface LiveCacheRefreshResult {
    changes: Array<{ name: string; value: string }>;
    rebuild: boolean;
    readMs: number;
    unavailable?: Array<{ name: string; error?: string }>;
    frame?: {
        values: Array<{ id: string; value?: string; status: 'ok' | 'unavailable'; error?: string }>;
        stats: {
            phase: string;
            progressDone: number;
            progressTotal: number;
            blockCount: number;
            memoryReadCommands: number;
            receivedBytes: number;
            fallbackFieldCount: number;
            memoryReadMs: number;
            fallbackMs: number;
            fallbackExamples: string[];
            subscribedFieldCount: number;
            successfulFieldCount: number;
            readMs: number;
            totalMs: number;
            errors: string[];
        };
    };
    mode?: 'bulk' | 'legacy' | 'native' | 'prepare' | 'unavailable';
    error?: string;
    preparing?: boolean;
    matrices?: LiveMatrixSample[];
}

interface LiveSubscriptionRequestNode {
    id: string;
    parent?: string;
    kind: 'container' | 'deref';
    pointer?: string;
}

interface LiveMemoryRequestOptions {
    mode: 'auto' | 'legacy';
    maxBlockBytes: number;
    mergeGapBytes: number;
    maxDepth: number;
    extraRamRegions: Array<{ start: number; end: number }>;
}

function formatLiveNumber(value: string, type: string, hexadecimal: boolean): string {
    if (type.includes('*') || /\b(?:float|double|_Float\d*)\b/i.test(type)) { return value; }
    const raw = value.trim();
    if (!/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) { return value; }
    try {
        const negative = raw.startsWith('-');
        const digits = /^[+-]/.test(raw) ? raw.slice(1) : raw;
        const number = BigInt(digits) * (negative ? BigInt(-1) : BigInt(1));
        if (!hexadecimal) { return number.toString(10); }
        return number < BigInt(0) ? `-0x${(-number).toString(16)}` : `0x${number.toString(16)}`;
    } catch (_error) {
        return value;
    }
}

export class LiveVariableNode extends BaseNode {
    protected session: vscode.DebugSession | undefined;        // This is transient
    protected children: LiveVariableNode[] | undefined;
    protected prevValue: string = '';
    private hasSample = false;
    private changedInLastSample = false;
    private childrenDiscovered = false;
    public monitorAll = false;
    private loadedCount = 64;
    private hasMore = false;
    private pinnedLocal: PinnedLocalInfo | undefined;
    private serialChannel: string | undefined;
    private serialHz: number | undefined;
    private serialLastAt = 0;
    private gdbVarName: string | undefined;
    private rawType = '';
    private typeKind = '';
    private matrixShape: LiveMatrixShape | undefined;
    private matrixValues: string[] = [];
    private matrixChanged: boolean[] = [];
    private matrixError: string | undefined;
    private matrixSampledAt: number | undefined;
    private matrixInitialized = false;
    private matrixDimensions: { rows: number; columns: number } | undefined;
    public displayMode: LiveDisplayMode = 'auto';
    constructor(
        parent: LiveVariableNode | undefined,
        protected name: string,
        protected expr: string,       // Any string for top level ars but lower level ones are actual children's simple names
        protected value = '',         // Current value
        protected type = '',          // C/C++ Type if any
        protected variablesReference = 0) {   // Variable reference returned by the debugger (only valid per-session)
        super(parent);
        // Constructor values come from GDB's variable discovery, not a memory sample.
    }

    public getExpr(): string {
        return this.expr;
    }

    public getName(): string { return this.name; }

    public getGdbVarName(): string | undefined { return this.gdbVarName; }

    public getLoadedChildren(): LiveVariableNode[] | undefined { return this.children; }

    public setMatrixInfo(shape?: LiveMatrixShape): void {
        if (JSON.stringify(shape) !== JSON.stringify(this.matrixShape)) {
            this.matrixValues = [];
            this.matrixChanged = [];
            this.matrixError = undefined;
            this.matrixSampledAt = undefined;
            this.matrixInitialized = false;
            LiveWatchTreeProvider.bumpSubscription();
        }
        this.matrixShape = shape;
        if (shape && !this.matrixInitialized) {
            this.matrixInitialized = true;
            LiveWatchTreeProvider.bumpSubscription();
        }
    }

    public getMatrixShape(): LiveMatrixShape | undefined {
        if (!this.matrixShape) { return undefined; }
        const override = this.matrixDimensions;
        return override && this.matrixShape.kind === 'array'
            && override.rows * override.columns === this.matrixShape.rows * this.matrixShape.columns
            ? { ...this.matrixShape, ...override }
            : this.matrixShape;
    }

    public usesMatrixDisplay(): boolean {
        return Boolean(this.matrixShape && (this.displayMode === 'matrix'
            || (this.displayMode === 'auto' && this.matrixShape.automatic)));
    }

    public setMatrixDimensions(rows: number, columns: number): boolean {
        const shape = this.matrixShape;
        if (!shape || shape.kind !== 'array' || !validMatrixShape(rows, columns)
            || rows * columns !== shape.rows * shape.columns) { return false; }
        this.matrixDimensions = { rows, columns };
        return true;
    }

    public getMatrixRequest(): LiveMatrixRequest | undefined {
        const shape = this.getMatrixShape();
        return shape && this.gdbVarName && (this.expanded || this.isUnderMonitorAll())
            ? { id: this.gdbVarName, rows: shape.rows, columns: shape.columns }
            : undefined;
    }

    public applyMatrixSamples(samples: ReadonlyMap<string, LiveMatrixSample>, updated: LiveVariableNode[]): void {
        const sample = this.gdbVarName ? samples.get(this.gdbVarName) : undefined;
        const shape = this.getMatrixShape();
        if (sample && shape) {
            const count = shape.rows * shape.columns;
            const valid = !sample.error && sample.values.length === count;
            this.matrixChanged = valid
                ? sample.values.map((value, i) =>
                        this.matrixValues.length === count && this.matrixValues[i] !== value)
                : [];
            this.matrixValues = valid ? sample.values.slice() : [];
            this.matrixError = sample.error || (valid ? undefined : '矩阵采样不完整');
            this.matrixSampledAt = Date.now();
            updated.push(this);
            // Default tree mode keeps the existing Eigen member tree, but array
            // leaves receive the same validated matrix sample instead of layout errors.
            const updateLeaves = (node: LiveVariableNode, indexes: number[] = []): void => {
                const index = /^\[?(\d+)\]?$/.exec(node.name);
                const next = index ? [...indexes, Number(index[1])] : indexes;
                if (valid && index && node.variablesReference === 0) {
                    let logical = -1;
                    if (shape.kind === 'array' && next.length === 2) {
                        logical = next[0] * this.matrixShape.columns + next[1];
                    } else if (next.length === 1) {
                        const linear = next[0];
                        logical = shape.rowMajor
                            ? linear
                            : (linear % shape.rows) * shape.columns + Math.floor(linear / shape.rows);
                    }
                    if (logical >= 0 && logical < count) {
                        node.acceptSample(sample.values[logical]);
                        updated.push(node);
                    }
                }
                for (const child of node.children ?? []) {
                    updateLeaves(child, next);
                }
            };
            if (!this.usesMatrixDisplay()) { updateLeaves(this); }
        }
        for (const child of this.children ?? []) {
            child.applyMatrixSamples(samples, updated);
        }
    }

    public canEditValue(): boolean {
        if (!LiveWatchTreeProvider.session || this.session !== LiveWatchTreeProvider.session
            || !this.gdbVarName || !this.hasSample || this.serialChannel || this.pinnedLocal
            || this.variablesReference > 0 || this.isDataPointer() || this.isArray()
            || this.typeKind === 'function-pointer' || /\bconst\b/.test(this.rawType || this.type)) { return false; }
        let ancestor = this.getParent() as LiveVariableNode | undefined;
        while (ancestor) {
            if (ancestor.pinnedLocal || ancestor.serialChannel
                || (!ancestor.isDataPointer() && /\bconst\b/.test(ancestor.rawType || ancestor.type))) { return false; }
            ancestor = ancestor.getParent() as LiveVariableNode | undefined;
        }
        return this.typeKind === 'scalar' || this.typeKind === 'enum';
    }

    public getViewRow(depth: number, hexadecimal: boolean, emptyValue = '等待首次采样'): LiveValueRow {
        const treeItem = this.getTreeItem(hexadecimal) as TreeItem;
        const rawLabel = this.name.startsWith('\'') && this.isRootChild()
            ? this.name.slice(this.name.lastIndexOf('::') + 2)
            : this.name;
        const target = this.getFunctionTarget();
        const shape = this.getMatrixShape();
        return {
            path: this.getPlotPath(), label: rawLabel,
            value: this.usesMatrixDisplay() ? `${shape.rows} × ${shape.columns}` : this.displayValue(hexadecimal, emptyValue),
            changed: this.changedInLastSample, depth,
            expandable: treeItem.collapsibleState !== TreeItemCollapsibleState.None,
            expanded: this.expanded, root: Boolean(this.isRootChild()),
            monitorAll: this.monitorAll, hasMore: this.hasMore,
            tooltip: typeof treeItem.tooltip === 'string' ? treeItem.tooltip : this.type,
            functionTarget: target?.name || '', plottable: this.getPlotValue() !== undefined,
            editable: this.canEditValue(), displayMode: this.displayMode, matrixShape: shape,
            matrix: this.usesMatrixDisplay()
                ? {
                        rows: shape.rows, columns: shape.columns,
                        values: this.matrixValues, changed: this.matrixChanged, error: this.matrixError,
                        timestampMs: this.matrixSampledAt
                    }
                : undefined
        };
    }

    public isDerefNode(): boolean { return this.name === '*'; }

    /** True when this node's children should stay subscribed/sampled. */
    public isActiveContainer(): boolean {
        if (this.usesMatrixDisplay()) { return false; }
        if (!this.parent) { return false; }         // the synthetic root
        if (!this.isDataPointer() && this.variablesReference === 0) { return false; }
        return shouldTraverseLiveChildren(this.isDataPointer(), this.expanded,
            this.isUnderMonitorAll(), LiveWatchTreeProvider.hasPlotDescendant(this.getPlotPath()),
            this.typeKind === 'scalar' || this.typeKind === 'enum' || this.typeKind === 'function-pointer',
            this.pointerAncestorCount());
    }

    /** A plot keeps only its selected branch alive when the UI is collapsed. */
    public getSamplingChildren(): LiveVariableNode[] {
        if (!this.isActiveContainer()) { return []; }
        const children = this.children ?? [];
        if (shouldTraverseLiveChildren(this.isDataPointer(), this.expanded, this.isUnderMonitorAll(), false,
            this.typeKind === 'scalar' || this.typeKind === 'enum' || this.typeKind === 'function-pointer',
            this.pointerAncestorCount())) { return children; }
        return children.filter((child) => LiveWatchTreeProvider.isPlotPath(child.getPlotPath()));
    }

    private pointerAncestorCount(): number {
        let count = 0;
        let node = this.getParent() as LiveVariableNode | undefined;
        while (node) {
            if (node.isDataPointer()) { count++; }
            node = node.getParent() as LiveVariableNode | undefined;
        }
        return count;
    }

    public needsDiscovery(): boolean {
        return Boolean(this.gdbVarName) && !this.childrenDiscovered
            && this.depth() < 12 && this.isActiveContainer();
    }

    public discoverChildrenShallow(): Promise<void> {
        return new Promise<void>((resolve) => this.refreshChildren(resolve, false));
    }

    public setTypeInfo(rawType: string, typeKind: string): void {
        this.rawType = rawType || this.rawType;
        this.typeKind = typeKind || this.typeKind;
    }

    public setPinnedLocal(info: PinnedLocalInfo): void {
        this.pinnedLocal = info;
    }

    public isPinnedLocal(): boolean { return Boolean(this.pinnedLocal); }

    public removePinnedLocals(): void {
        this.children = this.children?.filter((child) => !child.pinnedLocal);
    }

    public setSerialChannel(channel: string): void {
        this.serialChannel = channel;
        this.serialLastAt = Date.now();
    }

    public getSerialChannel(): string | undefined { return this.serialChannel; }

    public removeSerialWatches(): void {
        this.children = this.children?.filter((child) => !child.serialChannel);
    }

    public hasDebuggerWatches(): boolean {
        return Boolean(this.children?.some((child) => !child.serialChannel));
    }

    public hasSerialWatches(): boolean {
        return Boolean(this.children?.some((child) => child.serialChannel));
    }

    public updateSerialValues(values: Record<string, number>, actualHz: number | undefined): LiveVariableNode[] {
        const changed: LiveVariableNode[] = [];
        for (const child of this.children ?? []) {
            const channel = child.serialChannel;
            if (!channel || values[channel] === undefined) { continue; }
            const oldValue = child.value;
            const oldHighlight = child.changedInLastSample;
            child.acceptSample(String(values[channel]));
            child.serialHz = actualHz;
            child.serialLastAt = Date.now();
            if (oldValue !== child.value || oldHighlight !== child.changedInLastSample) {
                changed.push(child);
            }
        }
        return changed;
    }

    public markSerialUnavailable(now: number): LiveVariableNode[] {
        const changed: LiveVariableNode[] = [];
        for (const child of this.children ?? []) {
            if (!child.serialChannel || now - child.serialLastAt < 1000 || child.value === '<串口无新数据>') {
                continue;
            }
            child.showUnavailable('<串口无新数据>');
            child.serialHz = undefined;
            changed.push(child);
        }
        return changed;
    }

    private acceptSample(value: string): void {
        this.changedInLastSample = this.hasSample && this.value !== value;
        this.prevValue = this.value;
        this.value = value;
        this.hasSample = true;
    }

    /** Varobj values only describe the tree; they are not evidence of a live read. */
    private acceptDiscoveredValue(value: string): void {
        if (!this.hasSample) { this.value = value; }
    }

    private displayValue(hexadecimal: boolean, emptyValue: string): string {
        if (!this.hasSample && !this.value.startsWith('<') && this.value !== '{...}'
            && (this.isDataPointer() || this.variablesReference === 0)) {
            return emptyValue;
        }
        if (this.variablesReference > 0 && !this.isDataPointer() && this.value.length > 80) {
            return '{...}';
        }
        return (this.isDataPointer() ? this.value : formatLiveNumber(this.value, this.type, hexadecimal)) || emptyValue;
    }

    private showUnavailable(value: string): void {
        this.value = value;
        this.changedInLastSample = false;
        this.hasSample = false;
        this.gdbVarName = undefined;
        this.children = undefined;
    }

    public clearChangeHighlights(): void {
        this.changedInLastSample = false;
        this.matrixChanged = this.matrixChanged.map(() => false);
        for (const child of this.children ?? []) {
            if (!child.serialChannel) { child.clearChangeHighlights(); }
        }
    }

    public applyCacheChanges(changes: ReadonlyMap<string, string>, updated: LiveVariableNode[]): void {
        if (this.serialChannel) { return; }
        const next = this.gdbVarName ? changes.get(this.gdbVarName) : undefined;
        if (next !== undefined) {
            const oldValue = this.value;
            const oldHighlight = this.changedInLastSample;
            this.acceptSample(next);
            if (oldValue !== this.value || oldHighlight !== this.changedInLastSample) { updated.push(this); }
        } else if (this.changedInLastSample) {
            this.changedInLastSample = false;
            updated.push(this);
        }
        for (const child of this.children ?? []) {
            child.applyCacheChanges(changes, updated);
        }
    }

    /** Applies one bulk frame (values + unavailable markers) to the subtree. */
    public applyFrameValues(
        values: ReadonlyMap<string, string>,
        unavailable: ReadonlyMap<string, string | undefined>,
        updated: LiveVariableNode[]
    ): void {
        if (this.serialChannel) { return; }
        const id = this.gdbVarName;
        if (id) {
            if (unavailable.has(id)) {
                const text = `<${unavailable.get(id) || '采样不可用'}>`;
                if (this.value !== text) {
                    this.value = text;
                    this.changedInLastSample = false;
                    this.hasSample = false;
                    updated.push(this);
                }
            } else {
                const next = values.get(id);
                if (next !== undefined) {
                    const oldValue = this.value;
                    const oldHighlight = this.changedInLastSample;
                    this.acceptSample(next);
                    if (oldValue !== this.value || oldHighlight !== this.changedInLastSample) { updated.push(this); }
                } else if (this.changedInLastSample) {
                    this.changedInLastSample = false;
                    updated.push(this);
                }
            }
        }
        for (const child of this.children ?? []) {
            child.applyFrameValues(values, unavailable, updated);
        }
    }

    public getPlotPath(): string {
        const parent = this.getParent() as LiveVariableNode | undefined;
        return !parent || !parent.getParent() ? this.expr : `${parent.getPlotPath()}\u001f${this.name}`;
    }

    public getPlotLabel(): string {
        const parent = this.getParent() as LiveVariableNode | undefined;
        if (!parent || !parent.getParent()) { return this.expr; }
        const base = parent.getPlotLabel();
        if (this.name === '*') { return `*(${base})`; }
        return this.name.startsWith('[') ? `${base}${this.name}` : `${base}.${this.name}`;
    }

    public getPlotValue(): number | undefined {
        if (!this.hasSample || this.variablesReference > 0 || this.isDataPointer() || this.isArray()) { return undefined; }
        const raw = this.value.trim();
        if (/^[+-]?0x[0-9a-f]+$/i.test(raw)) {
            const negative = raw.startsWith('-');
            const digits = raw.replace(/^[+-]?0x/i, '');
            const value = Number.parseInt(digits, 16) * (negative ? -1 : 1);
            return Number.isSafeInteger(value) ? value : undefined;
        }
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) { return undefined; }
        const value = Number(raw);
        if (!Number.isFinite(value) || (/^[+-]?\d+$/.test(raw) && !Number.isSafeInteger(value))) {
            return undefined;
        }
        return value;
    }

    public collectPlotValues(paths: ReadonlySet<string>, result: Record<string, number | null>): void {
        const path = this.getPlotPath();
        if (paths.has(path)) { result[path] = this.getPlotValue() ?? null; }
        if (!path || [...paths].some((selected) => selected.startsWith(`${path}\u001f`))) {
            for (const child of this.children ?? []) {
                child.collectPlotValues(paths, result);
            }
        }
    }

    private isDataPointer(): boolean {
        if (this.typeKind === 'function-pointer') { return false; }
        if (this.typeKind) { return this.typeKind === 'pointer'; }
        return this.type.includes('*') && !/\(\s*\*/.test(this.type);
    }

    public getFunctionTarget(): SymbolInformation | undefined {
        const pointerLike = this.typeKind
            ? (this.typeKind === 'pointer' || this.typeKind === 'function-pointer')
            : this.type.includes('*');
        if (!pointerLike && !/0x[0-9a-f]+\s+</i.test(this.value)) { return undefined; }
        return LiveWatchTreeProvider.resolveFunctionAddress(this.value);
    }

    private isArray(): boolean {
        return this.typeKind === 'array' || /\[[^\]]+\]$/.test(this.type);
    }

    public loadMorePage(): boolean {
        if (!this.isArray() || !this.hasMore) { return false; }
        this.loadedCount += 64;
        return true;
    }

    public hasMorePages(): boolean { return this.hasMore; }

    private isNullPointer(): boolean {
        return /^(?:0x0+|0|nullptr|<nullptr>)(?:\s|$)/i.test(this.value.trim());
    }

    private ensurePointerChild(): void {
        if (this.isDataPointer() && !this.isNullPointer() && this.children?.[0]?.getName() !== '*') {
            this.children = [new LiveVariableNode(this, '*', `*(${this.expr})`)];
            LiveWatchTreeProvider.bumpSubscription();
        }
    }

    public setMonitorAll(value: boolean): void {
        if (!this.isRootChild()) { return; }
        this.monitorAll = value;
    }

    /** Each new session samples only manually expanded branches or selected plots. */
    public collapseForNewSession(): void {
        this.expanded = false;
        this.monitorAll = false;
        for (const child of this.children ?? []) {
            child.collapseForNewSession();
        }
    }

    public isMonitorAll(): boolean {
        return this.monitorAll;
    }

    private isUnderMonitorAll(): boolean {
        if (this.monitorAll) { return true; }
        let node = this.getParent() as LiveVariableNode | undefined;
        while (node) {
            if (node.monitorAll) { return true; }
            node = node.getParent() as LiveVariableNode | undefined;
        }
        return false;
    }

    private depth(): number {
        let depth = 0;
        let node = this.getParent();
        while (node) {
            depth++;
            node = node.getParent();
        }
        return depth;
    }

    public getChildren(): LiveVariableNode[] {
        if (!this.parent && (!this.children || !this.children.length)) {
            return [new LiveVariableNodeMsg(this)];
        }
        if (this.isDataPointer() && this.isNullPointer()) {
            this.children = undefined;
            return [];
        }

        this.ensurePointerChild();
        const ret = [...(this.children ?? [])];
        if (this.hasMore) { ret.push(new LiveVariableNodeMore(this)); }
        if (!this.parent && !this.session) {
            ret.push(new LiveVariableNodeMsg(this, false));
        }
        return ret;
    }

    public hasRealChildren(): boolean { return Boolean(this.children?.length); }

    public isRootChild(): boolean {
        const node = this.parent;
        return node && (node.getParent() === undefined);
    }

    public rename(nm: string) {
        if (this.isRootChild()) {
            this.name = this.expr = nm;
        }
    }

    public findName(str: string): LiveVariableNode | undefined {
        for (const child of this.children || []) {
            if (child.name === str) {
                return child;
            }
        }
        return undefined;
    }

    public getTreeItem(hexadecimal = false): TreeItem | Promise<TreeItem> {
        const canExpand = this.isDataPointer()
            ? !this.isNullPointer()
            : !(this.typeKind === 'scalar' || this.typeKind === 'enum' || this.typeKind === 'function-pointer')
                && (this.variablesReference > 0 || (this.children?.length > 0));
        const state = canExpand
            ? (this.expanded ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed)
            : TreeItemCollapsibleState.None;

        const parts = this.name.startsWith('\'') && this.isRootChild() ? this.name.split('\'::') : [this.name];
        const name = parts.pop();
        const loaded = this.hasMore ? ` [已读取 ${this.children?.length || 0}/${this.indexedVariables || '?'}]` : '';
        const prefix = name + (this.monitorAll ? ' [全部字段]' : '') + loaded + ': ';
        const functionTarget = this.getFunctionTarget();
        const targetSuffix = functionTarget && !this.value.includes(`<${functionTarget.name}>`)
            ? ` → ${functionTarget.name}()`
            : '';
        const fallback = LiveWatchTreeProvider.session ? '等待首次采样' : '等待 Live Watch 调试会话';
        const displayed = this.displayValue(hexadecimal, fallback);
        const label: vscode.TreeItemLabel = { label: prefix + displayed + targetSuffix };
        if (this.changedInLastSample) {
            label.highlights = [[prefix.length, prefix.length + displayed.length]];
        }

        const item = new TreeItem(label, state);
        item.id = this.getPlotPath();
        if (this.changedInLastSample) {
            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
        }
        item.contextValue = this.isRootChild() ? 'expression' : 'field';
        let file = parts.length ? parts[0].slice(1) : '';
        if (file) {
            const cwd = this.session?.configuration?.cwd;
            file = cwd ? getPathRelative(cwd, file) : file;
        }
        item.tooltip = (file ? 'File: ' + file + '\n' : '') + this.type
            + (functionTarget ? `\n当前目标：${functionTarget.name}\n源码：${functionTarget.file || '未知'}` : '');
        if (!this.hasSample && this.value.startsWith('<')) {
            item.tooltip += `\n${this.value}`;
        }
        if (this.pinnedLocal) {
            item.tooltip += `\n局部变量：${this.pinnedLocal.sourceExpression}`
                + `\n捕获位置：${this.pinnedLocal.functionName || '未知函数'}`
                + `\n固定地址：${this.pinnedLocal.address}`
                + '\n函数返回后该地址可能被复用；跨调用监控请用 static 镜像。';
        }
        if (this.serialChannel) {
            item.tooltip += `\n串口通道：${this.serialChannel}`
                + (this.serialHz ? `\n最近接收频率：${this.serialHz.toFixed(1)} Hz` : '');
        }
        if (functionTarget) {
            item.command = {
                command: 'rm-debug.liveWatch.gotoFunctionTarget',
                title: '跳转到当前函数目标', arguments: [this]
            };
        }
        return item;
    }

    public getCopyValue(): string {
        throw new Error('Method not implemented.');
    }

    public addChild(name: string, expr: string = '', value = '', type = '', reference = 0): LiveVariableNode {
        if (!this.children) {
            this.children = [];
        }
        const child = new LiveVariableNode(this, name, expr || name, value, type, reference);
        this.children.push(child);
        return child;
    }

    public removeChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                this.children.splice(ix, 1);
                return true;
            }
            ix++;
        }
        return false;
    }

    public moveUpChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix > 0) {
                    const prev = this.children[ix - 1];
                    this.children[ix] = prev;
                    this.children[ix - 1] = child;
                } else {
                    const first = this.children.shift();
                    this.children.push(first);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public moveDownChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        const last = this.children ? this.children.length - 1 : -1;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix !== last) {
                    const next = this.children[ix + 1];
                    this.children[ix] = next;
                    this.children[ix + 1] = child;
                } else {
                    const last = this.children.pop();
                    this.children.unshift(last);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public reset(valuesToo = true) {
        if (this.serialChannel) { return; }
        this.session = undefined;
        if (valuesToo) {
            this.value = this.type = this.prevValue = '';
            this.hasSample = this.changedInLastSample = false;
            this.childrenDiscovered = false;
            this.variablesReference = 0;
            this.hasMore = false;
            this.gdbVarName = undefined;
            this.rawType = this.typeKind = '';
            this.matrixShape = undefined;
            this.matrixValues = [];
            this.matrixChanged = [];
            this.matrixError = undefined;
            this.matrixSampledAt = undefined;
            this.matrixInitialized = false;
        }
        for (const child of this.children || []) {
            child.reset(valuesToo);
        }
    }

    private namedVariables: number = 0;
    private indexedVariables: number = 0;
    private refreshChildren(resolve: () => void, recursive = true) {
        if (!LiveWatchTreeProvider.session || (this.session !== LiveWatchTreeProvider.session)) {
            resolve();
        } else if (this.isDataPointer()) {
            if (this.isNullPointer()) {
                this.children = undefined;
                this.childrenDiscovered = true;
                resolve();
            } else if (this.isActiveContainer()) {
                this.ensurePointerChild();
                const child = this.children?.[0];
                if (child) {
                    child.refresh(this.session, undefined, !recursive).finally(() => {
                        this.childrenDiscovered = true;
                        resolve();
                    });
                } else {
                    resolve();
                }
            } else {
                resolve();
            }
        } else if (this.isActiveContainer() && this.depth() < 12 && this.variablesReference > 0) {
            // TODO: Implement limits on number of children in adapter and then here
            // const start = this.children?.length ?? 0;
            const varg: DebugProtocol.VariablesArguments = {
                variablesReference: this.variablesReference
                // start: start,
                // count: 32
                // filter: this.namedVariables > 0 ? 'named' : 'indexed'
            };
            const oldChildrenByName = new Map<string, LiveVariableNode>();
            for (const child of this.children ?? []) {
                oldChildrenByName.set(child.name, child);
            }
            if (this.isArray()) {
                const initialCount = this.isUnderMonitorAll() ? Math.max(64, LiveWatchTreeProvider.arrayPageSize) : 64;
                this.loadedCount = Math.max(this.loadedCount, initialCount);
                varg.start = 0;
                varg.count = this.indexedVariables > 0
                    ? Math.min(this.loadedCount, this.indexedVariables)
                    : this.loadedCount;
            }
            this.session.customRequest('liveVariables', varg).then((result) => {
                this.childrenDiscovered = true;
                this.hasMore = Boolean(varg.count && result?.variables?.length >= varg.count
                    && (!this.indexedVariables || this.indexedVariables > varg.count));
                let childrenChanged = false;
                if (!result?.variables?.length) {
                    if (this.children?.length) { childrenChanged = true; }
                    this.children = undefined;
                } else {
                    this.children = [];
                    for (const variable of result.variables ?? []) {
                        let ch = oldChildrenByName.get(variable.name);
                        if (ch) {
                            const nextType = variable.type || '';
                            const nextReference = variable.variablesReference ?? 0;
                            if (ch.type !== nextType || ch.variablesReference !== nextReference) {
                                ch.children = undefined;
                                ch.childrenDiscovered = false;
                                ch.hasMore = false;
                            }
                            ch.expr = variable.evaluateName || variable.name;
                            ch.gdbVarName = variable.gdbVarName;
                            ch.acceptDiscoveredValue(variable.value || '');
                            ch.type = nextType;        // This will become tooltip
                            ch.setTypeInfo(variable.rawType || '', variable.typeKind || '');
                            ch.variablesReference = nextReference;
                            ch.expanded = ch.expanded && (nextReference > 0 || ch.isDataPointer());
                        } else {
                            ch = new LiveVariableNode(
                                this,
                                variable.name,
                                variable.evaluateName || variable.name,
                                variable.value || '',
                                variable.type || '',        // This will become tooltip
                                variable.variablesReference ?? 0);
                            ch.gdbVarName = variable.gdbVarName;
                            ch.setTypeInfo(variable.rawType || '', variable.typeKind || '');
                            childrenChanged = true;
                        }
                        ch.session = this.session;
                        ch.setMatrixInfo(variable.matrix);
                        ch.indexedVariables = variable.indexedVariables ?? 0;
                        this.children.push(ch);
                    }
                }
                if (childrenChanged) { LiveWatchTreeProvider.bumpSubscription(); }
                if (!recursive) {
                    resolve();
                    return;
                }
                const activeChildren = this.getSamplingChildren().filter((child) => child.isActiveContainer());
                const refreshBatches = async () => {
                    for (let start = 0; start < activeChildren.length; start += 4) {
                        const batch = activeChildren.slice(start, start + 4);
                        await Promise.allSettled(batch.map((child) => new Promise<void>((done) => {
                            child.refreshChildren(done);
                        })));
                    }
                };
                void refreshBatches().finally(resolve);
            }, (e) => {
                this.showUnavailable(`<字段不可用：${String(e).slice(0, 180)}>`);
                this.hasMore = false;
                resolve();
            });
        } else {
            resolve();
        }
    }

    public expandChildren(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.expanded = true;
            // If we still have a current session, try to get the children or
            // wait for the next timer
            this.refreshChildren(resolve);
        });
    }

    public refresh(
        session: vscode.DebugSession, onRootComplete?: (node: LiveVariableNode) => void, shallow = false
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.serialChannel) {
                resolve();
                return;
            }
            this.session = session;
            if (session !== LiveWatchTreeProvider.session) {
                resolve();
                return;
            }
            if (this.expr) {
                const arg: DebugProtocol.EvaluateArguments = {
                    expression: this.expr,
                    context: 'watch'
                };
                session.customRequest('liveEvaluate', arg).then((result) => {
                    if (result?.unavailable) {
                        this.showUnavailable(result.result || '<Live Watch 变量不可读取>');
                        resolve();
                    } else if (result && result.result !== undefined) {
                        const oldType = this.type;
                        const oldGdbName = this.gdbVarName;
                        this.acceptDiscoveredValue(result.result);
                        this.gdbVarName = result.gdbVarName;
                        if (oldGdbName !== this.gdbVarName) { LiveWatchTreeProvider.bumpSubscription(); }
                        this.type = result.type || '';
                        this.setTypeInfo(result.rawType || '', result.typeKind || '');
                        this.variablesReference = result.variablesReference ?? 0;
                        this.namedVariables = result.namedVariables ?? 0;
                        this.indexedVariables = result.indexedVariables ?? 0;
                        if (oldType !== this.type) {
                            this.children = this.variablesReference ? [] : undefined;
                            this.childrenDiscovered = false;
                            this.hasMore = false;
                        }
                        this.setMatrixInfo(result.matrix);
                        this.refreshChildren(resolve, !shallow);
                    } else {
                        this.showUnavailable('<Live Watch 不可用或变量不可读取>');
                        resolve();
                    }
                }, (error) => {
                    this.showUnavailable(`<变量不可用：${String(error).slice(0, 180)}>`);
                    resolve();
                });
            } else if (this.children && !this.parent) {
                // This is the root node
                const promises = [];
                for (const child of this.children) {
                    promises.push(child.refresh(session, undefined, shallow).finally(() => onRootComplete?.(child)));
                }
                Promise.allSettled(promises).finally(() => {
                    resolve();
                });
            } else {
                this.refreshChildren(resolve);
            }
        });
    }

    public addNewExpr(expr: string): boolean {
        if (this.parent) {
            // You can't add new expressions unless at the root
            return false;
        }
        for (const child of this.children || []) {
            if (expr === child.expr) {
                return false;
            }
        }
        this.addChild(expr, expr);
        return true;
    }

    private pvtSerialize(state: NodeState | undefined): NodeState {
        const item: NodeState = {
            name: this.name,
            expr: this.expr,
            expanded: this.expanded || !this.parent,
            monitorAll: this.monitorAll,
            loadedCount: this.loadedCount,
            displayMode: this.displayMode,
            matrixDimensions: this.matrixDimensions,
            children: []
        };
        if (!state) {
            state = item;
        } else {
            state.children.push(item);
        }
        for (const child of this.children ?? []) {
            if (!child.pinnedLocal && !child.serialChannel) { child.pvtSerialize(item); }
        }
        return item;
    }

    public serialize(): NodeState {
        return this.pvtSerialize(undefined);
    }

    public deSerialize(state: NodeState): void {
        for (const child of state.children) {
            if (!this.children) {
                this.children = [];
            }
            const item = new LiveVariableNode(this, child.name, child.expr);
            item.expanded = false;
            item.monitorAll = Boolean(child.monitorAll);
            item.loadedCount = child.loadedCount || 64;
            item.displayMode = child.displayMode || 'auto';
            item.matrixDimensions = child.matrixDimensions;
            this.children.push(item);
            item.deSerialize(child);
        }
    }
}

class LiveVariableNodeMsg extends LiveVariableNode {
    constructor(parent: LiveVariableNode, private empty = true) {
        super(parent, 'dummy', 'dummy');
    }

    public getTreeItem(): TreeItem | Promise<TreeItem> {
        const state = TreeItemCollapsibleState.None;
        const tmp = 'Hint: Use & Enable "liveWatch" in your launch.json to enable this panel';
        const label: vscode.TreeItemLabel = {
            label: tmp + (this.empty ? ', and use the \'+\' button above to add new expressions' : '')
        };
        const item = new TreeItem(label, state);
        item.contextValue = this.isRootChild() ? 'expression' : 'field';
        item.tooltip = '~' + label.label + '~';
        return item;
    }

    public getChildren(): LiveVariableNode[] {
        return [];
    }
}

class LiveVariableNodeMore extends LiveVariableNode {
    constructor(private readonly target: LiveVariableNode) {
        super(target, '加载更多数组元素…', '');
    }

    public getTreeItem(): TreeItem {
        const item = new TreeItem('加载更多数组元素…', TreeItemCollapsibleState.None);
        item.command = {
            command: 'rm-debug.liveWatch.loadMore', title: '加载更多数组元素', arguments: [this.target]
        };
        return item;
    }

    public getChildren(): LiveVariableNode[] { return []; }
}

interface NodeState {
    name: string;
    expr: string;
    expanded: boolean;
    monitorAll?: boolean;
    loadedCount?: number;
    displayMode?: LiveDisplayMode;
    matrixDimensions?: { rows: number; columns: number };
    children: NodeState[];
}

const VERSION_ID = 'livewatch.version';
const WATCH_LIST_STATE = 'livewatch.watchTree';
const SAMPLE_RATE_STATE = 'rm-debug.liveWatchRate';

export class LiveWatchTreeProvider implements TreeDataProvider<LiveVariableNode> {
    // tslint:disable-next-line:variable-name
    public _onDidChangeTreeData: EventEmitter<LiveVariableNode | undefined> = new EventEmitter<LiveVariableNode | undefined>();
    public readonly onDidChangeTreeData: Event<LiveVariableNode | undefined> = this._onDidChangeTreeData.event;
    private readonly sampleEmitter = new EventEmitter<LivePlotSample>();
    public readonly onDidCompleteSample = this.sampleEmitter.event;
    private readonly valuesEmitter = new EventEmitter<LiveValuesSample>();
    public readonly onDidUpdateValues = this.valuesEmitter.event;
    private static valuePanelCount = 0;
    public static notifyValuePanel(open: boolean): void {
        LiveWatchTreeProvider.valuePanelCount = Math.max(
            0, LiveWatchTreeProvider.valuePanelCount + (open ? 1 : -1));
    }

    private readonly plotStatusEmitter = new EventEmitter<LivePlotStatus>();
    public readonly onDidChangePlotStatus = this.plotStatusEmitter.event;

    private static stateVersion = 2;
    private static plotPaths: ReadonlySet<string> = new Set<string>();
    private readonly plotNodes = new Map<string, LiveVariableNode>();
    private plotNodeRevision = -1;
    /** Bumped when the set of sampled nodes or the tree shape changes. */
    public static subscriptionRevision = 0;
    public static arrayPageSize = 64;
    public static bumpSubscription(): void { LiveWatchTreeProvider.subscriptionRevision++; }
    private variables: LiveVariableNode;
    public static session: vscode.DebugSession | undefined;
    private static functionSymbols: SymbolInformation[] = [];
    public state: vscode.TreeItemCollapsibleState;
    private timeout: NodeJS.Timeout | undefined;
    private timeoutMs: number = 250;
    private isStopped = true;
    private requestedSamplesPerSecond = 4;
    private readonly sampleTimes: number[] = [];
    private refreshInFlight = false;
    private refreshPending = false;
    private refreshSessionId: string | undefined;
    private incrementalReady = false;
    private discoveryRootsInFlight = false;
    private readonly rootDiscoveryAttempted = new Set<LiveVariableNode>();
    private discoveryStepInFlight = false;
    private lastDiscoveryStepAt = 0;
    private lastGdbReadMs = 0;
    private lastFieldRefreshMs = 0;
    private lastSentRevision = -1;
    private lastBulkSummary = '';
    private refreshError = '';
    private preparingLayout = false;
    private pendingMatrixSamples: LiveMatrixSample[] = [];
    private readonly diagnostics: vscode.OutputChannel;
    private lastDiagnosticAt = 0;
    private lastDiagnosticSignature = '';
    private uiFireTimer: NodeJS.Timeout | undefined;
    private pendingTreeFire = false;
    private uiFlushTimer: NodeJS.Timeout | undefined;
    private pendingFullFire = false;
    private readonly uiRefreshTimes: number[] = [];
    private lastChangedCount = 0;
    private renderCount = 0;
    private renderWindowStart = 0;
    private renderRowsPerSecond = 0;
    private treeView: vscode.TreeView<LiveVariableNode> | undefined;
    private serialFireTimer: NodeJS.Timeout | undefined;
    private serialStaleTimer: NodeJS.Timeout | undefined;
    private readonly pendingSerialUpdates = new Set<LiveVariableNode>();

    protected oldState = new Map <string, vscode.TreeItemCollapsibleState>();
    constructor(private context: vscode.ExtensionContext) {
        this.diagnostics = vscode.window.createOutputChannel('rm_debug Live Watch');
        context.subscriptions.push(this.diagnostics);
        this.variables = new LiveVariableNode(undefined, '', '');
        this.setRefreshRate();
        this.applyLiveMemorySettings();
        this.restoreState();
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this))
        );
    }

    public setTreeView(view: vscode.TreeView<LiveVariableNode>): void {
        this.treeView = view;
        this.updateRateDescription();
    }

    public findViewNode(path: string): LiveVariableNode | undefined {
        const visit = (nodes: LiveVariableNode[]): LiveVariableNode | undefined => {
            for (const node of nodes) {
                if (node.getPlotPath() === path) { return node; }
                const child = visit(node.getLoadedChildren() ?? []);
                if (child) { return child; }
            }
            return undefined;
        };
        return visit(this.variables.getLoadedChildren() ?? []);
    }

    public async setViewValue(path: string, value: string, sessionId: string): Promise<LiveWriteResult> {
        const session = LiveWatchTreeProvider.session;
        const node = this.findViewNode(path);
        if (!session || session.id !== sessionId || !node?.canEditValue()) {
            throw new Error('此变量当前不可编辑，或调试会话已经切换');
        }
        const name = node.getGdbVarName();
        try {
            const result = await session.customRequest('liveSetValue', { name, value }) as LiveWriteResult;
            if (!this.isSameSession(session) || this.findViewNode(path) !== node || node.getGdbVarName() !== name) {
                throw new Error('调试会话或变量已变化，已丢弃过期的修改结果');
            }
            return result;
        } finally {
            // Display a real sample even if assignment succeeded but readback failed.
            if (this.isSameSession(session)) { this.refresh(session); }
        }
    }

    public getViewRows(): LiveValueRow[] {
        const rows: LiveValueRow[] = [];
        const hexadecimal = !vscode.workspace.getConfiguration('cortex-debug')
            .get('variableUseNaturalFormat', true);
        let emptyValue = '等待首次采样';
        if (!LiveWatchTreeProvider.session) {
            emptyValue = '等待 Live Watch 调试会话';
        } else if (this.refreshError) {
            emptyValue = `刷新失败：${this.refreshError}`;
        } else if (this.preparingLayout) {
            emptyValue = '准备字段布局…';
        }
        const visit = (node: LiveVariableNode, depth: number): void => {
            rows.push(node.getViewRow(depth, hexadecimal, emptyValue));
            if (node.expanded && !node.usesMatrixDisplay()) {
                for (const child of node.getChildren()) {
                    if (!(child instanceof LiveVariableNodeMore)) { visit(child, depth + 1); }
                }
                if (node.hasMorePages()) {
                    rows.push({
                        path: `${node.getPlotPath()}\u001f__more`, label: '加载更多数组元素…', value: '',
                        changed: false, depth: depth + 1, expandable: false, expanded: false,
                        root: false, monitorAll: false, hasMore: true, tooltip: '',
                        functionTarget: '', plottable: false, editable: false
                    });
                }
            }
        };
        for (const node of this.variables.getLoadedChildren() ?? []) {
            visit(node, 0);
        }
        return rows;
    }

    public setViewExpanded(path: string, expanded: boolean): void {
        const node = this.findViewNode(path);
        if (!node || node.expanded === expanded) { return; }
        if (expanded) {
            this.expandChildren(node);
            this.saveState();
        } else {
            node.expanded = false;
            this.subscriptionChanged();
            this.saveState();
            this.fire();
        }
    }

    public setViewDisplayMode(path: string, mode: LiveDisplayMode): void {
        const node = this.findViewNode(path);
        if (!node || !['auto', 'tree', 'matrix'].includes(mode)) { return; }
        if (mode === 'matrix' && !node.getMatrixShape()) {
            void vscode.window.showInformationMessage('当前变量不是可识别的固定矩阵或数值数组');
            return;
        }
        node.displayMode = mode;
        this.subscriptionChanged();
        this.saveState();
        this.fire();
        if (node.expanded && !node.usesMatrixDisplay()) { this.expandChildren(node); }
    }

    public async setViewMatrixDimensions(path: string): Promise<void> {
        const node = this.findViewNode(path);
        const shape = node?.getMatrixShape();
        if (!shape || shape.kind !== 'array') { return; }
        const text = await vscode.window.showInputBox({ title: '矩阵行列数', value: `${shape.rows}x${shape.columns}`,
            prompt: `输入 行x列，例如 4x4；元素总数必须为 ${shape.rows * shape.columns}`,
            validateInput: (value) => {
                const match = /^(\d+)\s*[x×,]\s*(\d+)$/.exec(value.trim());
                return match && validMatrixShape(Number(match[1]), Number(match[2]))
                    && Number(match[1]) * Number(match[2]) === shape.rows * shape.columns
                    ? undefined
                    : '行列数必须为正整数，且乘积等于数组元素数';
            } });
        const match = text && /^(\d+)\s*[x×,]\s*(\d+)$/.exec(text.trim());
        if (match && node.setMatrixDimensions(Number(match[1]), Number(match[2]))) {
            this.setViewDisplayMode(path, 'matrix');
        }
    }

    /** Called by the tree view when expand/collapse changes the sampled set. */
    public subscriptionChanged(): void {
        this.incrementalReady = false;
        LiveWatchTreeProvider.bumpSubscription();
    }

    public static hasPlotDescendant(path: string): boolean {
        if (!path) { return false; }
        for (const selected of LiveWatchTreeProvider.plotPaths) {
            if (selected.startsWith(`${path}\u001f`)) { return true; }
        }
        return false;
    }

    public static isPlotPath(path: string): boolean {
        return LiveWatchTreeProvider.plotPaths.has(path) || LiveWatchTreeProvider.hasPlotDescendant(path);
    }

    public setPlotPaths(paths: ReadonlySet<string>): void {
        if (paths.size === LiveWatchTreeProvider.plotPaths.size
            && [...paths].every((path) => LiveWatchTreeProvider.plotPaths.has(path))) { return; }
        const before = JSON.stringify([this.collectSubscription(), this.collectMatrixRequests()]);
        LiveWatchTreeProvider.plotPaths = new Set(paths);
        this.plotNodes.clear();
        this.plotNodeRevision = -1;
        // Adding a channel already in the live frame is only a UI change.
        // Rebuilding the memory plan would re-read GDB layouts and addresses.
        const after = JSON.stringify([this.collectSubscription(), this.collectMatrixRequests()]);
        if (before !== after) { LiveWatchTreeProvider.bumpSubscription(); }
    }

    public static resolveFunctionAddress(value: string): SymbolInformation | undefined {
        const match = value.match(/0x[0-9a-f]+/i);
        if (!match) { return undefined; }
        const address = Math.floor(Number.parseInt(match[0], 16) / 2) * 2;
        const symbols = LiveWatchTreeProvider.functionSymbols;
        let low = 0;
        let high = symbols.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (symbols[middle].address <= address) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const symbol = symbols[low - 1];
        return symbol && address < symbol.address + Math.max(1, symbol.length) ? symbol : undefined;
    }

    private updateRateDescription(): void {
        if (!this.treeView) { return; }
        const decimal = vscode.workspace.getConfiguration('cortex-debug').get('variableUseNaturalFormat', true);
        const format = decimal ? '十进制' : '十六进制';
        if (!LiveWatchTreeProvider.session) {
            this.treeView.description = `等待 Live Watch 会话 · ${format}`;
            return;
        }
        const length = this.sampleTimes.length;
        const elapsed = length > 1 ? this.sampleTimes[length - 1] - this.sampleTimes[0] : 0;
        const actual = elapsed > 0 ? `${((length - 1) * 1000 / elapsed).toFixed(1)} Hz` : '等待采样';
        const uiLength = this.uiRefreshTimes.length;
        const uiElapsed = uiLength > 1 ? this.uiRefreshTimes[uiLength - 1] - this.uiRefreshTimes[0] : 0;
        const ui = uiElapsed > 0 ? ` · 界面 ${((uiLength - 1) * 1000 / uiElapsed).toFixed(1)} Hz` : '';
        const nowMs = Date.now();
        if (!this.renderWindowStart) { this.renderWindowStart = nowMs; }
        if (nowMs - this.renderWindowStart >= 1000) {
            this.renderRowsPerSecond = this.renderCount * 1000 / (nowMs - this.renderWindowStart);
            this.renderCount = 0;
            this.renderWindowStart = nowMs;
        }
        const redraw = ui ? ` · 重绘 ${this.renderRowsPerSecond.toFixed(0)} 行/秒` : '';
        const last = length ? ` · 最近 ${new Date(this.sampleTimes[length - 1]).toLocaleTimeString()}` : '';
        const timing = length ? ` · GDB ${this.lastGdbReadMs} ms · 字段 ${this.lastFieldRefreshMs} ms` : '';
        const bulk = this.lastBulkSummary ? ` · ${this.lastBulkSummary}` : '';
        this.treeView.description = `目标 ${this.requestedSamplesPerSecond} Hz · 实际 ${actual}${ui}${redraw}${bulk} · ${format}${timing}${last}`;
    }

    public getSamplingRate(): number {
        return this.requestedSamplesPerSecond;
    }

    public setSamplingRate(value: number): boolean {
        if (!LiveWatchTreeProvider.session || !Number.isFinite(value) || value < 1 || value > 20) { return false; }
        this.requestedSamplesPerSecond = value;
        this.timeoutMs = 1000 / value;
        void this.context.workspaceState.update(SAMPLE_RATE_STATE, value);
        this.sampleTimes.length = 0;
        this.updateRateDescription();
        if (!this.isStopped) { this.startTimer(); }
        return true;
    }

    public toggleMonitorAll(node: LiveVariableNode): boolean | undefined {
        if (!node?.isRootChild()) { return undefined; }
        node.setMonitorAll(!node.isMonitorAll());
        this.saveState();
        LiveWatchTreeProvider.bumpSubscription();
        this.refresh(LiveWatchTreeProvider.session);
        this.fire();
        return node.isMonitorAll();
    }

    public loadMore(node: LiveVariableNode): void {
        if (node?.loadMorePage() && LiveWatchTreeProvider.session) {
            this.saveState();
            LiveWatchTreeProvider.bumpSubscription();
            this.refresh(LiveWatchTreeProvider.session);
        }
    }

    private restoreState() {
        try {
            const state = this.context.workspaceState;
            const ver = state.get(VERSION_ID) ?? LiveWatchTreeProvider.stateVersion;
            if (ver === LiveWatchTreeProvider.stateVersion) {
                const data = state.get(WATCH_LIST_STATE);
                const saved = data as NodeState;
                if (saved) {
                    this.variables.deSerialize(saved);
                }
            }
        } catch (error) {
            console.error('live-watch.restoreState', error);
        }
    }

    private currentRefreshRate = LiveWatchTreeProvider.defaultRefreshRate;
    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration('cortex-debug.liveWatchRefreshRate')) {
            this.setRefreshRate();
        }
        if (e.affectsConfiguration('cortex-debug.variableUseNaturalFormat')) {
            this.updateRateDescription();
            this.fire();
        }
        if (e.affectsConfiguration('rm-debug.liveMemory')) {
            this.applyLiveMemorySettings();
            this.incrementalReady = false;
            LiveWatchTreeProvider.bumpSubscription();
        }
    }

    private applyLiveMemorySettings(): void {
        const config = vscode.workspace.getConfiguration('rm-debug');
        const page = Number(config.get('liveMemoryArrayPageSize'));
        LiveWatchTreeProvider.arrayPageSize = Number.isFinite(page) ? Math.max(16, Math.min(1024, page)) : 64;
    }

    private static defaultRefreshRate = 300;
    private static minRefreshRate = 200;        // Seems to be the magic number
    private static maxRefreshRate = 5000;
    private setRefreshRate() {
        const config = vscode.workspace.getConfiguration('cortex-debug', null);
        let rate = config.get('liveWatchRefreshRate', LiveWatchTreeProvider.defaultRefreshRate);
        rate = Math.max(rate, LiveWatchTreeProvider.minRefreshRate);
        rate = Math.min(rate, LiveWatchTreeProvider.maxRefreshRate);
        this.currentRefreshRate = rate;
    }

    public saveState() {
        const state = this.context.workspaceState;
        const data = this.variables.serialize();
        state.update(VERSION_ID, LiveWatchTreeProvider.stateVersion);
        state.update(WATCH_LIST_STATE, data);
    }

    private isSameSession(session: vscode.DebugSession): boolean {
        if (session && LiveWatchTreeProvider.session && (session.id === LiveWatchTreeProvider.session.id)) {
            return true;
        }
        return false;
    }

    /** Map one new top-level watch while the current bulk plan keeps sampling. */
    private discoverPendingRoot(session: vscode.DebugSession): void {
        if (this.discoveryRootsInFlight || !this.isSameSession(session)) { return; }
        const node = (this.variables.getLoadedChildren() ?? []).find((root) =>
            !root.getSerialChannel() && !root.getGdbVarName() && !this.rootDiscoveryAttempted.has(root));
        if (!node) { return; }
        this.rootDiscoveryAttempted.add(node);
        this.discoveryRootsInFlight = true;
        const started = Date.now();
        void node.refresh(session, undefined, true).finally(() => {
            if (!this.isSameSession(session)) { return; }
            this.discoveryRootsInFlight = false;
            this.lastFieldRefreshMs = Date.now() - started;
            this.scheduleNodeUpdates([node]);
            if (this.isStopped) { this.refresh(session); }
        });
    }

    public refresh(session: vscode.DebugSession, restarTimer = false): void {
        if (session && this.isSameSession(session)) {
            if (!restarTimer) { this.incrementalReady = false; }
            const restart = (elapsed: number) => {
                if (this.refreshSessionId && this.refreshSessionId !== session.id) { return; }
                this.refreshInFlight = false;
                this.refreshSessionId = undefined;
                if (!this.isSameSession(session)) { return; }
                if (this.refreshPending) {
                    this.refreshPending = false;
                    if (this.isStopped) {
                        this.refresh(session, true);
                    } else {
                        this.startTimer(elapsed);
                    }
                } else if (!this.isStopped) {
                    this.startTimer(elapsed);
                }
            };
            if (this.refreshInFlight) {
                if (!restarTimer) { this.refreshPending = true; }
            } else if (!this.variables.hasDebuggerWatches()) {
                restart(0);
            } else {
                this.refreshInFlight = true;
                this.refreshSessionId = session.id;
                this.killTimer();
                const start = Date.now();
                const requestArgs: any = { deleteAll: false, options: this.memoryOptions() };
                if (this.lastSentRevision !== LiveWatchTreeProvider.subscriptionRevision) {
                    requestArgs.revision = LiveWatchTreeProvider.subscriptionRevision;
                    requestArgs.subscription = this.collectSubscription();
                    requestArgs.matrices = this.collectMatrixRequests();
                }
                const requestedRevision: number | undefined = requestArgs.revision;
                // The following will update all the variables in the backend cache in bulk
                session.customRequest('liveCacheRefresh', requestArgs).then((cache: LiveCacheRefreshResult) => {
                    if (!this.isSameSession(session)) {
                        restart(0);
                        return;
                    }
                    this.refreshError = '';
                    this.pendingMatrixSamples = cache.matrices || [];
                    this.preparingLayout = cache?.mode === 'prepare';
                    this.reportSamplingFrame(cache);
                    if (cache?.mode === 'unavailable') {
                        this.refreshError = cache.error || 'Live Watch GDB 未连接';
                        this.lastBulkSummary = 'GDB 未连接';
                        this.refreshInFlight = false;
                        this.refreshSessionId = undefined;
                        this.updateRateDescription();
                        this.fire();
                        return;
                    }
                    if (cache?.mode === 'prepare') {
                        this.discoverPendingRoot(session);
                        this.lastBulkSummary = `准备布局 ${cache.frame?.stats.progressDone ?? 0}/${cache.frame?.stats.progressTotal ?? 0}`;
                        const changedNodes: LiveVariableNode[] = [];
                        this.variables.applyCacheChanges(
                            new Map((cache.changes ?? []).map((change) => [change.name, change.value])), changedNodes);
                        this.lastGdbReadMs = cache.readMs ?? 0;
                        this.finishSample(session, changedNodes, true, (cache.changes?.length ?? 0) > 0);
                        if (!this.isStopped) {
                            restart(Date.now() - start);
                        } else {
                            this.refreshInFlight = false;
                            this.refreshSessionId = undefined;
                            // A manual refresh while paused must finish the layout preparation too.
                            setTimeout(() => {
                                if (this.isSameSession(session) && this.isStopped) { this.refresh(session); }
                            }, 0);
                        }
                        this.fire();
                        return;
                    }
                    if (cache?.mode === 'bulk') {
                        this.discoverPendingRoot(session);
                        if (requestedRevision !== undefined) { this.lastSentRevision = requestedRevision; }
                        this.applyBulkFrame(session, cache, start, restart);
                        return;
                    }
                    const incremental = restarTimer && this.incrementalReady && cache && !cache.rebuild;
                    const changedNodes: LiveVariableNode[] = [];
                    if (!incremental && !this.discoveryRootsInFlight) {
                        this.discoveryRootsInFlight = true;
                        const fieldsStart = Date.now();
                        this.diagnostics.appendLine('开始映射顶层字段；采样循环继续运行');
                        void this.variables.refresh(session, (node) => {
                            if (this.isSameSession(session)) {
                                this.scheduleNodeUpdates([node]);
                                this.diagnostics.appendLine(`顶层字段已映射：${node.getPlotLabel()}`);
                            }
                        }, true).finally(() => {
                            if (!this.isSameSession(session)) { return; }
                            this.discoveryRootsInFlight = false;
                            this.incrementalReady = true;
                            this.lastFieldRefreshMs = Date.now() - fieldsStart;
                            this.diagnostics.appendLine(`顶层字段映射完成：${this.lastFieldRefreshMs} ms`);
                        });
                    }
                    // A layout rebuild must not discard values already sampled in this frame.
                    // Legacy frames also carry unchanged leaves to establish their first sample.
                    if (cache) {
                        const values = new Map(cache.changes.map((change) => [change.name, change.value]));
                        if (cache.mode === 'native' || cache.mode === 'legacy') {
                            this.variables.applyFrameValues(values,
                                new Map((cache.unavailable ?? []).map((item) => [item.name, item.error])), changedNodes);
                        } else {
                            this.variables.applyCacheChanges(values, changedNodes);
                        }
                    }
                    if (requestedRevision !== undefined) { this.lastSentRevision = requestedRevision; }
                    this.lastGdbReadMs = cache?.readMs ?? 0;
                    const error = cache?.frame?.stats.errors?.[0];
                    this.lastBulkSummary = cache?.mode === 'native'
                        ? 'MuJoCo 本机批量采样'
                        : cache?.mode === 'legacy'
                            ? `兼容逐字段${error ? `：${error.slice(0, 72)}` : ''}`
                            : '';
                    this.finishSample(session, changedNodes, incremental,
                        (cache?.changes?.length ?? 0) > 0);
                    restart(Date.now() - start);
                    this.advanceDiscovery(session);
                }, (error) => {
                    if (!this.isSameSession(session)) {
                        restart(0);
                        return;
                    }
                    this.preparingLayout = false;
                    this.refreshError = String(error).slice(0, 180);
                    this.diagnostics.appendLine(`Live Watch 刷新失败：${this.refreshError}`);
                    this.fire();
                    restart(0);
                });
            }
        } else {
            this.fire();
        }
    }

    private applyBulkFrame(
        session: vscode.DebugSession, cache: LiveCacheRefreshResult, start: number, restart: (elapsed: number) => void
    ): void {
        const values = new Map<string, string>();
        for (const change of cache.changes ?? []) {
            values.set(change.name, change.value);
        }
        const unavailable = new Map<string, string | undefined>();
        for (const item of cache.unavailable ?? []) {
            unavailable.set(item.name, item.error);
        }
        const changedNodes: LiveVariableNode[] = [];
        this.variables.applyFrameValues(values, unavailable, changedNodes);
        const stats = cache.frame?.stats;
        this.lastGdbReadMs = cache.readMs ?? stats?.readMs ?? 0;
        this.lastFieldRefreshMs = 0;
        if (stats) {
            this.lastBulkSummary = `批量 ${stats.blockCount} 块/${stats.receivedBytes} B`
                + ` · 成功 ${stats.successfulFieldCount}`
                + (stats.fallbackFieldCount ? ` · 回退 ${stats.fallbackFieldCount}` : '')
                + (unavailable.size ? ` · 不可用 ${unavailable.size}` : '');
        }
        this.finishSample(session, changedNodes, true, (stats?.successfulFieldCount || 0) > 0);
        restart(Date.now() - start);
        this.advanceDiscovery(session);
    }

    /** Discover one nested container after a memory frame, without blocking the sample loop. */
    private advanceDiscovery(session: vscode.DebugSession): void {
        if (!this.isSameSession(session) || this.discoveryRootsInFlight || this.discoveryStepInFlight
            || Date.now() - this.lastDiscoveryStepAt < 250) { return; }
        const queue = [...(this.variables.getLoadedChildren() ?? [])];
        let target: LiveVariableNode | undefined;
        while (queue.length > 0) {
            const node = queue.shift();
            if (!node) { continue; }
            if (node.needsDiscovery()) {
                target = node;
                break;
            }
            queue.push(...node.getSamplingChildren());
        }
        if (!target) { return; }
        this.discoveryStepInFlight = true;
        this.lastDiscoveryStepAt = Date.now();
        const current = target;
        void current.discoverChildrenShallow().finally(() => {
            if (this.isSameSession(session)) {
                this.discoveryStepInFlight = false;
                this.scheduleNodeUpdates([current]);
                this.diagnostics.appendLine(`字段映射：${current.getPlotLabel()}`);
            }
        });
    }

    private reportSamplingFrame(cache: LiveCacheRefreshResult | undefined): void {
        if (!cache) { return; }
        const stats = cache.frame?.stats;
        const mode = cache.mode || 'unknown';
        const signature = `${mode}:${stats?.phase || ''}:${stats?.fallbackFieldCount || 0}:${stats?.errors?.[0] || ''}`;
        const now = Date.now();
        if (signature === this.lastDiagnosticSignature && now - this.lastDiagnosticAt < 10000) { return; }
        this.lastDiagnosticAt = now;
        this.lastDiagnosticSignature = signature;
        this.diagnostics.appendLine(
            `[${new Date(now).toLocaleTimeString()}] ${mode}/${stats?.phase || 'unknown'}`
            + ` · ${stats?.memoryReadCommands || 0} 次内存读取/${stats?.receivedBytes || 0} B`
            + ` · 已解码 ${stats?.successfulFieldCount || 0}/订阅节点 ${stats?.subscribedFieldCount || 0}`
            + ` · 不可用 ${cache.unavailable?.length || 0}`
            + ` · 内存 ${stats?.memoryReadMs || 0} ms · 兼容 ${stats?.fallbackFieldCount || 0} 字段/${stats?.fallbackMs || 0} ms`
            + ` · GDB刷新 ${cache.readMs || 0} ms · 引擎 ${stats?.totalMs || 0} ms`
            + ` · 矩阵 ${cache.matrices?.length || 0} 个/${cache.matrices?.reduce((sum, sample) => sum + sample.values.length, 0) || 0} 元素`
            + ` · 树变更行 ${this.lastChangedCount}`
        );
        for (const error of stats?.errors || []) {
            this.diagnostics.appendLine(`  错误：${error}`);
        }
        for (const fallback of stats?.fallbackExamples || []) {
            this.diagnostics.appendLine(`  兼容：${fallback}`);
        }
        for (const matrix of cache.matrices || []) {
            if (matrix.error) { this.diagnostics.appendLine(`  矩阵：${matrix.name}：${matrix.error}`); }
        }
    }

    private finishSample(
        session: vscode.DebugSession, changedNodes: LiveVariableNode[], incremental: boolean, hasValues: boolean
    ): void {
        const now = Date.now();
        const matrices = this.pendingMatrixSamples;
        this.pendingMatrixSamples = [];
        this.variables.applyMatrixSamples(new Map(matrices.map((sample) => [sample.name, sample])), changedNodes);
        hasValues = hasValues || matrices.some((sample) => !sample.error && sample.values.length > 0);
        if (this.isStopped) { this.variables.clearChangeHighlights(); }
        if (!this.isStopped && hasValues) {
            this.sampleTimes.push(now);
            while (this.sampleTimes.length > 2 && this.sampleTimes[0] < now - 10000) {
                this.sampleTimes.shift();
            }
            this.updateRateDescription();
            this.emitPlotSample(session, now);
        } else if (!hasValues) {
            this.sampleTimes.length = 0;
            this.updateRateDescription();
        }
        // Publish every completed frame, including failed reads and paused refreshes.
        // The sidebar has no TreeView to repaint it when a frame has no valid values.
        this.emitValuesSample(session, now);
        if (this.treeView) {
            if (incremental) {
                this.scheduleNodeUpdates(changedNodes);
            } else {
                this.fireTreeThrottled();
            }
        } else if (this.isStopped) {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    /** Feeds the webview value table; only walks the tree when a table is open. */
    private emitValuesSample(session: vscode.DebugSession, now: number): void {
        if (LiveWatchTreeProvider.valuePanelCount === 0) { return; }
        const rows = this.getViewRows();
        const length = this.sampleTimes.length;
        const window = length > 1 ? now - this.sampleTimes[0] : 0;
        this.valuesEmitter.fire({
            sessionId: session.id,
            timestampMs: now,
            targetHz: this.requestedSamplesPerSecond,
            actualHz: window > 0 ? (length - 1) * 1000 / window : undefined,
            rows
        });
    }

    /**
     * Element-specific events are dropped by VS Code when the fired node is
     * not in its renderer cache, so drive a full tree repaint from the sample
     * loop instead: first change paints immediately, further changes are
     * coalesced to at most one repaint per 80 ms (~12 Hz).
     */
    private scheduleNodeUpdates(changedNodes: LiveVariableNode[]): void {
        if (changedNodes.length === 0) { return; }
        this.lastChangedCount = changedNodes.length;
        this.pendingFullFire = true;
        if (this.uiFlushTimer) { return; }
        this.pumpTreeFire();
    }

    private pumpTreeFire(): void {
        this.pendingFullFire = false;
        const now = Date.now();
        this.uiRefreshTimes.push(now);
        while (this.uiRefreshTimes.length > 2 && this.uiRefreshTimes[0] < now - 10000) {
            this.uiRefreshTimes.shift();
        }
        this._onDidChangeTreeData.fire(undefined);
        this.uiFlushTimer = setTimeout(() => {
            this.uiFlushTimer = undefined;
            if (this.pendingFullFire) { this.pumpTreeFire(); }
        }, 80);
    }

    private resetUiUpdates(): void {
        if (this.uiFlushTimer) {
            clearTimeout(this.uiFlushTimer);
            this.uiFlushTimer = undefined;
        }
        this.pendingFullFire = false;
        this.uiRefreshTimes.length = 0;
    }

    private emitPlotSample(session: vscode.DebugSession, now: number): void {
        if (LiveWatchTreeProvider.plotPaths.size > 0) {
            try {
                const values: Record<string, number | null> = {};
                for (const path of LiveWatchTreeProvider.plotPaths) {
                    values[path] = null;
                }
                if (this.plotNodeRevision !== LiveWatchTreeProvider.subscriptionRevision) {
                    this.plotNodes.clear();
                    const visit = (node: LiveVariableNode): void => {
                        const path = node.getPlotPath();
                        if (LiveWatchTreeProvider.plotPaths.has(path)) { this.plotNodes.set(path, node); }
                        for (const child of node.getLoadedChildren() ?? []) {
                            visit(child);
                        }
                    };
                    visit(this.variables);
                    this.plotNodeRevision = LiveWatchTreeProvider.subscriptionRevision;
                }
                for (const [path, node] of this.plotNodes) {
                    values[path] = node.getPlotValue() ?? null;
                }
                const length = this.sampleTimes.length;
                const interval = length > 1 ? now - this.sampleTimes[0] : 0;
                this.sampleEmitter.fire({
                    sessionId: session.id,
                    timestampMs: now,
                    actualHz: interval > 0 ? (length - 1) * 1000 / interval : undefined,
                    values
                });
            } catch (error) {
                console.error('Live Plot sample collection failed', error);
            }
        }
    }

    /** UI redraws are throttled so sampling is not paced by tree updates. */
    private fireTreeThrottled(): void {
        if (this.uiFireTimer) {
            this.pendingTreeFire = true;
            return;
        }
        this.fire();
        this.uiFireTimer = setTimeout(() => {
            this.uiFireTimer = undefined;
            if (this.pendingTreeFire) {
                this.pendingTreeFire = false;
                this.fireTreeThrottled();
            }
        }, 150);
    }

    /** Explicit subscription snapshot for the bulk sampler. */
    public collectSubscription(): LiveSubscriptionRequestNode[] {
        const result: LiveSubscriptionRequestNode[] = [];
        const visit = (node: LiveVariableNode, parentGdb: string | undefined): void => {
            if (node.getSerialChannel()) { return; }
            const id = node.getGdbVarName();
            if (!id) { return; }
            const isDeref = node.isDerefNode();
            result.push({
                id,
                parent: parentGdb,
                kind: isDeref ? 'deref' : 'container',
                pointer: isDeref ? parentGdb : undefined
            });
            for (const child of node.getSamplingChildren()) {
                visit(child, id);
            }
        };
        for (const root of this.variables.getLoadedChildren() ?? []) {
            visit(root, undefined);
        }
        return result;
    }

    public collectMatrixRequests(): LiveMatrixRequest[] {
        const result: LiveMatrixRequest[] = [];
        const visit = (node: LiveVariableNode): void => {
            if (node.getSerialChannel()) { return; }
            const matrix = node.getMatrixRequest();
            if (matrix) { result.push(matrix); }
            if (node.getMatrixShape()) { return; }
            for (const child of node.getSamplingChildren()) {
                visit(child);
            }
        };
        for (const root of this.variables.getLoadedChildren() ?? []) {
            visit(root);
        }
        return result;
    }

    private memoryOptions(): LiveMemoryRequestOptions {
        const config = vscode.workspace.getConfiguration('rm-debug');
        const clamp = (value: any, min: number, max: number, fallback: number): number => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
        };
        const extraRamRegions: Array<{ start: number; end: number }> = [];
        for (const value of config.get<string[]>('liveMemoryRamRanges', []) || []) {
            const match = /^\s*(0x[0-9a-fA-F]+|\d+)\s*-\s*(0x[0-9a-fA-F]+|\d+)\s*$/.exec(String(value));
            if (!match) { continue; }
            const start = match[1].toLowerCase().startsWith('0x') ? parseInt(match[1], 16) : parseInt(match[1], 10);
            const end = match[2].toLowerCase().startsWith('0x') ? parseInt(match[2], 16) : parseInt(match[2], 10);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                extraRamRegions.push({ start, end });
            }
        }
        return {
            mode: config.get<string>('liveMemorySampling', 'auto') === 'legacy' ? 'legacy' : 'auto',
            maxBlockBytes: clamp(config.get('liveMemoryMaxBlockBytes'), 256, 8192, 2048),
            mergeGapBytes: clamp(config.get('liveMemoryMergeGapBytes'), 0, 4096, 512),
            maxDepth: clamp(config.get('liveMemoryMaxDepth'), 1, 16, 8),
            extraRamRegions
        };
    }

    public getTreeItem(element: LiveVariableNode): TreeItem | Promise<TreeItem> {
        this.renderCount++;
        const decimal = vscode.workspace.getConfiguration('cortex-debug').get('variableUseNaturalFormat', true);
        return element?.getTreeItem(!decimal);
    }

    public getChildren(element?: LiveVariableNode): ProviderResult<LiveVariableNode[]> {
        return element ? element.getChildren() : this.variables.getChildren();
    }

    public getParent(element: LiveVariableNode): ProviderResult<LiveVariableNode> {
        const parent = element?.getParent() as LiveVariableNode | undefined;
        return parent === this.variables ? undefined : parent;
    }

    private startTimer(subtract: number = 0) {
        // console.error('Starting Timer');
        this.killTimer();
        this.timeout = setTimeout(() => {
            this.timeout = undefined;
            if (LiveWatchTreeProvider.session) {
                this.refresh(LiveWatchTreeProvider.session, true);
            }
        }, Math.max(0, this.timeoutMs - subtract));
    }

    private killTimer() {
        if (this.timeout) {
            // console.error('Killing Timer');
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
    }

    public debugSessionTerminated(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
            this.killTimer();
            this.resetUiUpdates();
            LiveWatchTreeProvider.session = undefined;
            this.refreshInFlight = false;
            this.refreshPending = false;
            this.refreshSessionId = undefined;
            LiveWatchTreeProvider.functionSymbols = [];
            this.incrementalReady = false;
            this.discoveryRootsInFlight = false;
            this.rootDiscoveryAttempted.clear();
            this.discoveryStepInFlight = false;
            this.lastDiscoveryStepAt = 0;
            this.variables.removePinnedLocals();
            this.sampleTimes.length = 0;
            this.plotStatusEmitter.fire({ sessionId: session.id, status: 'terminated' });
            this.updateRateDescription();
            this.fire();
            this.saveState();
            setTimeout(() => {
                // We hold the current values as they are until we start another debug session and
                // another fire() is called
                this.variables.reset(true);
            }, 100);
        }
    }

    public debugSessionStarted(session: vscode.DebugSession) {
        const liveWatch = session.configuration.liveWatch as LiveWatchConfig;
        if (!liveWatch?.enabled) {
            if (!LiveWatchTreeProvider.session) {
                // Force a child node to be created to provide a Hint
                this.fire();
            }
            return;
        }
        if (LiveWatchTreeProvider.session) {
            // For now, we can't handle more than one session (all variables needs to be relevant to the core being debugged)
            // Technically, it is not an issue but is problematic on how to specify in the UI, which watch expression belongs
            // to which session. Same as breakpoints or Watch variables.
            vscode.window.showErrorMessage(
                'Error: You can have live-watch enabled to only one debug session at a time. Live Watch is already enabled for '
                + LiveWatchTreeProvider.session.name);
            return;
        }
        LiveWatchTreeProvider.session = session;
        this.refreshInFlight = false;
        this.refreshPending = false;
        this.refreshSessionId = undefined;
        this.incrementalReady = false;
        this.discoveryRootsInFlight = false;
        this.rootDiscoveryAttempted.clear();
        this.discoveryStepInFlight = false;
        this.lastDiscoveryStepAt = 0;
        this.lastSentRevision = -1;
        this.lastBulkSummary = '';
        this.refreshError = '';
        this.preparingLayout = false;
        this.resetUiUpdates();
        LiveWatchTreeProvider.bumpSubscription();
        LiveWatchTreeProvider.functionSymbols = [];
        void session.customRequest('load-function-symbols').then((result) => {
            if (LiveWatchTreeProvider.session === session) {
                LiveWatchTreeProvider.functionSymbols = (result?.functionSymbols || [])
                    .sort((left: SymbolInformation, right: SymbolInformation) => left.address - right.address);
                this.fire();
            }
        }, () => { /* Live Watch remains usable without a symbol table. */ });
        this.isStopped = true;
        this.variables.reset();
        this.variables.collapseForNewSession();
        const savedRate = this.context.workspaceState.get<number>(SAMPLE_RATE_STATE);
        const samplesPerSecond = Math.max(1, Math.min(20, savedRate ?? liveWatch.samplesPerSecond ?? 4));
        this.requestedSamplesPerSecond = samplesPerSecond;
        this.timeoutMs = 1000 / samplesPerSecond;
        this.sampleTimes.length = 0;
        this.updateRateDescription();
        this.plotStatusEmitter.fire({ sessionId: session.id, status: 'stopped' });
        this.startTimer();
    }

    public debugStopped(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
            this.killTimer();
            this.variables.clearChangeHighlights();
            this.fire();
            this.plotStatusEmitter.fire({ sessionId: session.id, status: 'stopped' });
            // There are some pauses that are very brief, so lets not refresh when stopped. Lets
            // wait and see if the a refresh is needed or else it will already be performed if the
            // program has already continued
            setTimeout(() => {
                if (!this.timeout) {
                    this.refresh(LiveWatchTreeProvider.session);
                }
            }, 250);
        }
    }

    public debugContinued(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = false;
            this.plotStatusEmitter.fire({ sessionId: session.id, status: 'running' });
            this.startTimer();
        }
    }

    public addWatchExpr(expr: string, session: vscode.DebugSession, monitorAll = false): LiveVariableNode | undefined {
        expr = expr.trim();
        if (!expr) { return undefined; }
        let node = this.variables.findName(expr);
        if (!node && this.variables.addNewExpr(expr)) { node = this.variables.findName(expr); }
        if (monitorAll) { node?.setMonitorAll(true); }
        this.saveState();
        LiveWatchTreeProvider.bumpSubscription();
        this.fire();
        this.refresh(LiveWatchTreeProvider.session);
        return node;
    }

    public addPinnedLocal(
        label: string, expression: string, info: PinnedLocalInfo, session: vscode.DebugSession
    ): LiveVariableNode | undefined {
        if (!this.isSameSession(session)) { return undefined; }
        const name = `${label} [局部 ${info.address}]`;
        let node = this.variables.findName(name);
        if (!node) {
            node = this.variables.addChild(name, expression);
            node.setPinnedLocal(info);
        }
        this.saveState();
        this.fire();
        this.refresh(session);
        return node;
    }

    public addSerialChannel(channel: string): LiveVariableNode | undefined {
        channel = channel.trim();
        if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*$/.test(channel)) { return undefined; }
        const name = `${channel} [串口]`;
        let node = this.variables.findName(name);
        if (!node) {
            node = this.variables.addChild(name, `serial:${channel}`);
            node.setSerialChannel(channel);
        }
        this.ensureSerialStaleTimer();
        this.fire();
        return node;
    }

    public onSerialSample(values: Record<string, number>, actualHz: number | undefined): void {
        for (const node of this.variables.updateSerialValues(values, actualHz)) {
            this.pendingSerialUpdates.add(node);
        }
        this.ensureSerialStaleTimer();
        this.scheduleSerialFire();
    }

    private ensureSerialStaleTimer(): void {
        if (this.variables.hasSerialWatches() && !this.serialStaleTimer) {
            this.serialStaleTimer = setInterval(() => {
                for (const node of this.variables.markSerialUnavailable(Date.now())) {
                    this.pendingSerialUpdates.add(node);
                }
                this.scheduleSerialFire();
            }, 250);
        }
    }

    private scheduleSerialFire(): void {
        if (this.pendingSerialUpdates.size && !this.serialFireTimer) {
            this.serialFireTimer = setTimeout(() => {
                this.serialFireTimer = undefined;
                if (this.treeView) {
                    for (const node of this.pendingSerialUpdates) {
                        this._onDidChangeTreeData.fire(node);
                    }
                } else {
                    this._onDidChangeTreeData.fire(undefined);
                }
                this.pendingSerialUpdates.clear();
            }, 33);
        }
    }

    public serialSourceClosed(): void {
        if (this.serialFireTimer) { clearTimeout(this.serialFireTimer); }
        if (this.serialStaleTimer) { clearInterval(this.serialStaleTimer); }
        this.serialFireTimer = undefined;
        this.serialStaleTimer = undefined;
        this.pendingSerialUpdates.clear();
        this.variables.removeSerialWatches();
        this.fire();
    }

    public removeWatchExpr(node: LiveVariableNode) {
        try {
            if (this.variables.removeChild(node)) {
                if (!this.variables.hasSerialWatches() && this.serialStaleTimer) {
                    clearInterval(this.serialStaleTimer);
                    this.serialStaleTimer = undefined;
                }
                this.saveState();
                this.fire();
                if (!node.getSerialChannel()) { this.rebuildDebuggerVariables(); }
            }
        } catch (e) {
            // Sometimes we get a garbage node if this is called while we are (aggressively) polling
            console.error('Failed to remove node. Invalid node?', node);
        }
    }

    private rebuildDebuggerVariables(): void {
        const session = LiveWatchTreeProvider.session;
        if (!session) { return; }
        this.incrementalReady = false;
        LiveWatchTreeProvider.bumpSubscription();
        this.killTimer();
        void session.customRequest('liveCacheRefresh', { deleteAll: true }).then(() => {
            if (this.isSameSession(session)) {
                this.variables.reset(true);
                this.rootDiscoveryAttempted.clear();
                this.lastSentRevision = -1;
                this.refresh(session, !this.isStopped);
            }
        }, (error) => {
            console.error('Live Watch variable cleanup failed', error);
            if (!this.isStopped && this.isSameSession(session)) { this.startTimer(); }
        });
    }

    public editNode(node: LiveVariableNode) {
        if (!node.isRootChild()) {
            return;     // Should never happen
        }
        if (node.isPinnedLocal() || node.getSerialChannel()) {
            void vscode.window.showInformationMessage('rm_debug：请移除该临时监控项后重新添加。');
            return;
        }
        const opts: vscode.InputBoxOptions = {
            placeHolder: 'Enter a valid C/gdb expression. Must be a global variable expression',
            ignoreFocusOut: true,
            value: node.getName(),
            prompt: 'Enter Live Watch Expression'
        };
        vscode.window.showInputBox(opts).then((result) => {
            result = result ? result.trim() : result;
            if (result && (result !== node.getName())) {
                if (this.variables.findName(result)) {
                    vscode.window.showInformationMessage(`Live Watch: Expression ${result} is already being watched`);
                } else {
                    node.rename(result);
                    this.saveState();
                    this.fire();
                    this.rebuildDebuggerVariables();
                }
            }
        });
    }

    public moveUpNode(node: LiveVariableNode) {
        const parent = node?.getParent() as LiveVariableNode;
        if (parent && parent.moveUpChild(node)) {
            this.saveState();
            this.fire();
        }
    }

    public moveDownNode(node: LiveVariableNode) {
        const parent = node?.getParent() as LiveVariableNode;
        if (parent && parent.moveDownChild(node)) {
            this.saveState();
            this.fire();
        }
    }

    public expandChildren(element: LiveVariableNode) {
        if (element) {
            this.incrementalReady = false;
            LiveWatchTreeProvider.bumpSubscription();
            element.expandChildren().then(() => {
                this.fire();
            });
        }
    }

    private pendingFires = 0;
    private inFire = false;
    public fire() {
        if (this.timeoutMs >= this.currentRefreshRate) {
            this._onDidChangeTreeData.fire(undefined);
            return;
        }
        if (!this.inFire) {
            this.inFire = true;
            this._onDidChangeTreeData.fire(undefined);
            setTimeout(() => {
                this.inFire = false;
                if (this.pendingFires) {
                    this.pendingFires = 0;
                    this.fire();
                }
            }, this.currentRefreshRate);    // TODO: Timeout needs to be a user setting
        } else {
            this.pendingFires++;
        }
    }
}

/*
    async machineInfo() {
        if (this.sessionInfo === undefined)
            return undefined;
        const session = this.sessionInfo.session;
        const frameId = this.sessionInfo.frameId;
        if (this.sessionInfo.language === Language.Cpp) {
            //const expr1 = await this._evaluate(session, '(unsigned int)((unsigned char)-1)', frameId);
            const expr2 = await this._evaluate(session, 'sizeof(void*)', frameId);
            if (expr2 === undefined || expr2.type === undefined)
                return undefined;
            let pointerSize: number = 0;
            if (expr2.result === '4')
                pointerSize = 4;
            else if (expr2.result === '8')
                pointerSize = 8;
            else
                return undefined;
            const expr3 = await this._evaluate(session, 'sizeof(unsigned long)', frameId);
            if (expr3 === undefined || expr3.type === undefined)
                return undefined;
            let endianness: Endianness | undefined = undefined;
            let expression = '';
            let expectedLittle = '';
            let expectedBig = '';
            if (expr3.result === '4') {
                expression = '*(unsigned long*)"abc"';
                expectedLittle = '6513249';
                expectedBig = '1633837824';
            } else if (expr3.result === '8') {
                expression = '*(unsigned long*)"abcdefg"';
                expectedLittle = '29104508263162465';
                expectedBig = '7017280452245743360';
            } else
                return undefined;
            const expr4 = await this._evaluate(session, expression, frameId);
            if (expr4 === undefined || expr4.type === undefined)
                return undefined;
            if (expr4.result === expectedLittle)
                endianness = Endianness.Little;
            else if (expr4.result === expectedBig)
                endianness = Endianness.Big;
            else
                return undefined;
            return new MachineInfo(pointerSize, endianness);
        }
        return undefined;
    }
    */
