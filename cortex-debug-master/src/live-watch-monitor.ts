import { DebugProtocol } from '@vscode/debugprotocol';
import { Handles } from '@vscode/debugadapter';
import { MI2 } from './backend/mi2/mi2';
import { decodeReference, ExtendedVariable, GDBDebugSession, RequestQueue } from './gdb';
import { MIError, VariableObject, syntacticTypeKind } from './backend/backend';
import * as crypto from 'crypto';
import { MINode } from './backend/mi_parse';
import { expandValue } from './backend/gdb_expansion';
import { TypeResolver } from './backend/live-memory-types';
import { LiveWatchWriter, LiveWriteResult } from './backend/live-watch-write';
import { LiveMatrixReader } from './backend/live-matrix-reader';
import { LiveMatrixRequest, LiveMatrixSample, parseMatrixShape } from './live-matrix';
import {
    LiveMemoryEngine, LiveMemoryOptions, LiveMemorySampleResult, LiveSubscriptionNode
} from './live-memory-engine';

export type VariableType = string | VariableObject | ExtendedVariable;
export interface NameToVarChangeInfo {
    [name: string]: any;
}
export interface LiveCacheRefreshResult {
    changes: Array<{ name: string; value: string }>;
    rebuild: boolean;
    readMs: number;
    unavailable?: Array<{ name: string; error?: string }>;
    frame?: LiveMemorySampleResult;
    mode?: 'bulk' | 'legacy' | 'prepare';
    preparing?: boolean;
    matrices?: LiveMatrixSample[];
}

export interface LiveSubscriptionRequestNode {
    id: string;
    parent?: string;
    kind: 'container' | 'deref';
    pointer?: string;
}

export class VariablesHandler {
    public variableHandles = new Handles<VariableType>(256);
    public variableHandlesReverse = new Map<string, number>();
    public readonly variableParents = new Map<string, { parent: string; key: string }>();
    public cachedChangeList: NameToVarChangeInfo | undefined;
    private typeResolver: TypeResolver | undefined;
    private typeDebugger: MI2 | undefined;

    constructor(
        public isBusy: () => boolean,
        public busyError: (r: DebugProtocol.Response, a: any) => void
    ) { }

    public async clearCachedVars(miDebugger: MI2) {
        const roots: string[] = [];
        for (const [name, handle] of this.variableHandlesReverse) {
            const variable = this.variableHandles.get(handle);
            if (variable instanceof VariableObject && variable.parent === 0) { roots.push(name); }
        }
        const results = await Promise.allSettled(roots.map((name) => miDebugger.sendCommand(`var-delete ${name}`)));
        this.cachedChangeList = undefined;
        this.variableHandlesReverse.clear();
        this.variableParents.clear();
        this.variableHandles = new Handles<VariableType>(256);
        results.filter((result) => result.status === 'rejected')
            .forEach((result) => console.error('clearCachedValues', result.reason));
    }

    public getTypeResolver(miDebugger: MI2): TypeResolver {
        if (!this.typeResolver || this.typeDebugger !== miDebugger) {
            this.typeDebugger = miDebugger;
            this.typeResolver = new TypeResolver({
                console: (command) => miDebugger.sendCliCommand(command),
                evaluate: (expression) => miDebugger.evaluateNumber(expression)
            });
        }
        return this.typeResolver;
    }

    /** Eigen base nodes in MI paths can be temporary values rather than lvalues. */
    public matrixStoragePath(name: string): string | undefined {
        const chain: Array<{ key: string; parent: VariableObject }> = [];
        const visited = new Set<string>();
        let current = name;
        let skippedBase = false;
        for (let depth = 0; depth < 64 && !visited.has(current); depth++) {
            visited.add(current);
            const handle = this.variableHandlesReverse.get(current);
            const variable = handle === undefined ? undefined : this.variableHandles.get(handle);
            if (!(variable instanceof VariableObject)) { return undefined; }
            const info = this.variableParents.get(current);
            if (!info) {
                if (!skippedBase || variable.parent !== 0 || !variable.exp) { return undefined; }
                let expression = variable.exp;
                for (const { key, parent } of chain.reverse()) {
                    if (/^\d+$/.test(key)) {
                        expression = `(${expression})[${key}]`;
                    } else if (key === '*' || key.startsWith('*')) {
                        expression = `*(${expression})`;
                    } else if (/^[a-zA-Z_$][\w$]*$/.test(key)) {
                        const pointer = parent.typeKind === 'pointer' || syntacticTypeKind(parent.type || '') === 'pointer';
                        expression = `(${expression})${pointer ? '->' : '.'}${key}`;
                    } else {
                        return undefined;
                    }
                }
                return expression;
            }
            const parentHandle = this.variableHandlesReverse.get(info.parent);
            const parent = parentHandle === undefined ? undefined : this.variableHandles.get(parentHandle);
            if (!(parent instanceof VariableObject)) { return undefined; }
            // Eigen stores fixed matrices in an unambiguous inherited m_storage member.
            if (/^Eigen::(?:PlainObjectBase|MatrixBase|ArrayBase|DenseBase|DenseCoeffsBase|EigenBase)</.test(info.key)) {
                skippedBase = true;
            } else {
                chain.push({ key: info.key, parent });
            }
            current = info.parent;
        }
        return undefined;
    }

    /**
     * Resolves the declared type kind (pointer through typedefs, array, enum,
     * struct/union, scalar) for newly created children so the UI never has to
     * guess from the display tooltip.
     */
    private async classifyChildren(miDebugger: MI2, children: VariableObject[]): Promise<void> {
        const resolver = this.getTypeResolver(miDebugger);
        for (const child of children) {
            if (!child || child.typeKind) { continue; }
            const rawType = String(child.type || '').trim();
            if (!rawType) {
                child.typeKind = 'unknown';
                continue;
            }
            // The concrete kinds are already known from GDB's type text.
            // Resolve only typedefs and ambiguous types; one GDB type query
            // per ordinary scalar field can stall first-frame discovery.
            const syntactic = syntacticTypeKind(rawType);
            child.matrix = parseMatrixShape(rawType);
            if (syntactic !== 'typedef' && syntactic !== 'aggregate') {
                child.typeKind = syntactic;
                continue;
            }
            try {
                child.typeKind = await resolver.classifyTypeText(rawType);
                if (!child.matrix && (child.typeKind === 'struct' || child.typeKind === 'array')) {
                    child.matrix = parseMatrixShape(await resolver.declaredType(rawType) || '');
                }
            } catch (_error) {
                child.typeKind = 'unknown';
            }
        }
    }

    private invalidateChildrenCaches() {
        const handles = new Set<number>(this.variableHandlesReverse.values());
        for (const handle of handles) {
            const variable = this.variableHandles.get(handle);
            if (variable instanceof VariableObject) {
                variable.clearChildrenCache();
            }
        }
    }

    public async refreshCachedChangeList(
        miDebugger: MI2, includeUnchanged = false, subscription?: ReadonlySet<string>
    ): Promise<LiveCacheRefreshResult> {
        const start = Date.now();
        // Keep previously discovered, now collapsed branches out of wildcard var-update.
        // Freezing changes only GDB's variable cache, never the target's execution.
        if (subscription) {
            for (const [name, handle] of this.variableHandlesReverse) {
                const variable = this.variableHandles.get(handle);
                if (!(variable instanceof VariableObject)) { continue; }
                const frozen = !subscription.has(name);
                if (variable.frozen === frozen) { continue; }
                try {
                    await miDebugger.sendCommand(`var-set-frozen ${name} ${frozen ? 1 : 0}`);
                    variable.frozen = frozen;
                } catch (_error) { /* A stale var-object will be handled by refresh/discovery. */ }
            }
        }
        this.cachedChangeList = {};
        // Live Watch keeps the last value for unchanged scalar variables, so ask GDB
        // to return values only for simple (leaf) objects. Compound values are just
        // placeholders such as "{...}" and make large watch trees needlessly costly.
        const changedValues: LiveCacheRefreshResult['changes'] = [];
        const unavailable: NonNullable<LiveCacheRefreshResult['unavailable']> = [];
        let rebuild = false;
        try {
            const changes = await miDebugger.varUpdate('*', -1, -1, 'simple');
            const changelist = changes.result('changelist');
            for (const change of changelist || []) {
                const name = MINode.valueOf(change, 'name');
                if (this.cachedChangeList) { this.cachedChangeList[name] = change; }
                const inScope = MINode.valueOf(change, 'in_scope');
                const typeChanged = MINode.valueOf(change, 'type_changed');
                const vId = this.variableHandlesReverse.get(name);
                const v = vId === undefined ? undefined : this.variableHandles.get(vId) as VariableObject;
                if (!v) {
                    rebuild = true;
                    continue;
                }
                const previousValue = v.value;
                const newChildren = MINode.valueOf(change, 'new_num_children');
                const hasMore = MINode.valueOf(change, 'has_more');
                const layoutChanged = typeChanged === 'true'
                    || (newChildren !== undefined && Number(newChildren) !== v.numchild)
                    || (hasMore !== undefined && (hasMore === '1') !== v.hasMore);
                if (inScope === 'false' || layoutChanged) {
                    this.cachedChangeList = undefined;
                    this.invalidateChildrenCaches();
                    rebuild = true;
                }
                v.applyChanges(change);
                if (inScope === 'false') {
                    unavailable.push({ name, error: '变量当前不在作用域内' });
                    continue;
                }
                if (v.value !== undefined) {
                    changedValues.push({ name, value: v.value });
                }
                // A pointer changing address also changes the meaning of its expanded child tree.
                if ((v.typeKind === 'pointer' || syntacticTypeKind(v.type || '') === 'pointer')
                    && previousValue !== v.value) {
                    rebuild = true;
                }
            }
        } catch (error) {
            this.cachedChangeList = undefined;
            throw error;
        }
        if (includeUnchanged) {
            const values = new Map(changedValues.map((change) => [change.name, change.value]));
            const missing = new Set(unavailable.map((item) => item.name));
            for (const [name, handle] of this.variableHandlesReverse) {
                const variable = this.variableHandles.get(handle);
                if (variable instanceof VariableObject
                    && (!variable.isCompound() || variable.typeKind === 'pointer' || variable.typeKind === 'function-pointer')
                    && variable.value !== undefined && !missing.has(name)
                    && (!subscription || subscription.has(name))) {
                    values.set(name, variable.value);
                }
            }
            return {
                changes: [...values].filter(([name]) => !subscription || subscription.has(name))
                    .map(([name, value]) => ({ name, value })), unavailable,
                rebuild, readMs: Date.now() - start
            };
        }
        return { changes: changedValues, unavailable, rebuild, readMs: Date.now() - start };
    }

    public createVariable(arg: VariableType, options?: any) {
        if (options) {
            return this.variableHandles.create(new ExtendedVariable(arg, options));
        } else {
            return this.variableHandles.create(arg);
        }
    }

    public findOrCreateVariable(varObj: VariableObject): number {
        let id = this.variableHandlesReverse.get(varObj.name);
        if (id === undefined) {
            id = this.createVariable(varObj);
            this.variableHandlesReverse.set(varObj.name, id);
        }
        return varObj.isCompound() ? id : 0;
    }

    private evaluateQ = new RequestQueue<DebugProtocol.EvaluateResponse, DebugProtocol.EvaluateArguments>();
    public evaluateRequest(
        r: DebugProtocol.EvaluateResponse, a: DebugProtocol.EvaluateArguments,
        miDebugger: MI2, session: GDBDebugSession, forceNoFrameId = false): Promise<void> {
        a.context = a.context || 'hover';
        if (a.context !== 'repl') {
            if (this.isBusy()) {
                this.busyError(r, a);
                return Promise.resolve();
            }
        }

        const doit = (
            response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments,
            _pendContinue: any, miDebugger: MI2, session: GDBDebugSession) => {
            return new Promise<void>(async (resolve) => {
                if (this.isBusy() && (a.context !== 'repl')) {
                    this.busyError(response, args);
                    resolve();
                    return;
                }

                // Spec says if 'frameId' is specified, evaluate in the scope specified or in the global scope. Well,
                // we don't have a way to specify global scope ... use floating variable.
                let threadId = session.stoppedThreadId || 1;
                let frameId = 0;
                if (forceNoFrameId) {
                    threadId = frameId = -1;
                    args.frameId = undefined;
                } else if (args.frameId !== undefined) {
                    [threadId, frameId] = decodeReference(args.frameId);
                }

                if (args.context !== 'repl') {
                    try {
                        const exp = args.expression;
                        const hasher = crypto.createHash('sha256');
                        hasher.update(exp);
                        if (!forceNoFrameId && (args.frameId !== undefined)) {
                            hasher.update(args.frameId.toString(16));
                        }
                        const exprName = hasher.digest('hex');
                        const varObjName = `${args.context}_${exprName}`;
                        let varObj: VariableObject;
                        let varId = this.variableHandlesReverse.get(varObjName);
                        let forceCreate = varId === undefined;
                        let updateError;
                        if (!forceCreate) {
                            try {
                                const cachedChange = this.cachedChangeList && this.cachedChangeList[varObjName];
                                let changelist;
                                if (cachedChange) {
                                    changelist = [];
                                } else if (this.cachedChangeList && (varId !== undefined)) {
                                    changelist = [];
                                } else {
                                    const changes = await miDebugger.varUpdate(varObjName, threadId, frameId);
                                    changelist = changes.result('changelist') ?? [];
                                }
                                for (const change of changelist) {
                                    const inScope = MINode.valueOf(change, 'in_scope');
                                    if (inScope === 'true') {
                                        const name = MINode.valueOf(change, 'name');
                                        const vId = this.variableHandlesReverse.get(name);
                                        const v = this.variableHandles.get(vId) as any;
                                        v.applyChanges(change);
                                        if (this.cachedChangeList) {
                                            this.cachedChangeList[name] = change;
                                        }
                                    } else {
                                        const msg = `${exp} currently not in scope`;
                                        await miDebugger.sendCommand(`var-delete ${varObjName}`);
                                        if (session.args.showDevDebugOutput) {
                                            session.handleMsg('log', `Expression ${msg}. Will try to create again\n`);
                                        }
                                        forceCreate = true;
                                        throw new Error(msg);
                                    }
                                }
                                varObj = this.variableHandles.get(varId) as any;
                            } catch (err) {
                                updateError = err;
                            }
                        }
                        if (!this.isBusy() && (forceCreate || ((updateError instanceof MIError && updateError.message === 'Variable object not found')))) {
                            if (this.cachedChangeList) {
                                delete this.cachedChangeList[varObjName];
                            }
                            if (forceNoFrameId || (args.frameId === undefined)) {
                                varObj = await miDebugger.varCreate(0, exp, varObjName, '@');  // Create floating variable
                            } else {
                                varObj = await miDebugger.varCreate(0, exp, varObjName, '@', threadId, frameId);
                            }
                            varId = this.findOrCreateVariable(varObj);
                            varObj.exp = exp;
                            varObj.id = varId;
                        } else if (!varObj) {
                            throw updateError || new Error('live watch unknown error');
                        }

                        if (forceNoFrameId) { await this.classifyChildren(miDebugger, [varObj]); }
                        response.body = varObj.toProtocolEvaluateResponseBody();
                        response.success = true;
                        session.sendResponse(response);
                    } catch (err) {
                        if (this.isBusy()) {
                            this.busyError(response, args);
                        } else {
                            let detail = err.toString();
                            if (args.context !== 'hover') {
                                // A source declaration is not enough: --gc-sections can
                                // discard the object before it reaches the loaded ELF.
                                let address: string | undefined;
                                try {
                                    address = await miDebugger.evaluateNumber(`&(${args.expression})`);
                                } catch (_lookupError) {
                                    // Keep the original GDB error if the connection is gone.
                                }
                                if (address === '') {
                                    detail = `当前 ELF 中找不到 ${args.expression}：请确认模块参与链接、`
                                        + '变量未被链接器清理，且调试配置使用了刚编译的 ELF';
                                } else {
                                    detail = `读取 ${args.expression} 失败：${detail}`;
                                }
                            }
                            response.body = {
                                result: (args.context === 'hover') ? null : `<${detail}>`,
                                variablesReference: 0,
                                unavailable: true
                            } as any;
                            session.sendResponse(response);
                            if (session.args.showDevDebugOutput) {
                                session.handleMsg('stderr', args.context + ' ' + err.toString());
                            }
                        }
                        // this.sendErrorResponse(response, 7, err.toString());
                    } finally {
                        resolve();
                    }
                } else {        // This is an 'repl'
                    try {
                        miDebugger.sendUserInput(args.expression).then((output) => {
                            if (typeof output === 'undefined') {
                                response.body = {
                                    result: '',
                                    variablesReference: 0
                                };
                            } else {
                                response.body = {
                                    result: JSON.stringify(output),
                                    variablesReference: 0
                                };
                            }
                            session.sendResponse(response);
                            resolve();
                        }, (msg) => {
                            session.sendErrorResponsePub(response, 8, msg.toString());
                            resolve();
                        });
                    } catch (e) {
                        session.sendErrorResponsePub(response, 8, e.toString());
                        resolve();
                    }
                }
            });
        };

        return this.evaluateQ.add(doit, r, a, miDebugger, session);
    }

    public getCachedChilren(pVar: VariableObject): VariableObject[] | undefined {
        if (!this.cachedChangeList) { return undefined; }
        const keys = Object.keys(pVar.children);
        if (keys.length === 0) { return undefined; }        // We don't have previous children, force a refresh
        const ret: VariableObject[] = [];
        for (const key of keys) {
            const gdbVaName = pVar.children[key];
            const childId = this.variableHandlesReverse.get(gdbVaName);
            if (childId === undefined) {
                return undefined;
            }
            const childObj = this.variableHandles.get(childId) as VariableObject;
            ret.push(childObj);
        }
        return ret;
    }

    private getCachedRangeChildren(pVar: VariableObject, start: number, count: number): VariableObject[] | undefined {
        if (!this.cachedChangeList) { return undefined; }
        const names = pVar.rangeChildren[`${start}:${count}`];
        if (!names) { return undefined; }
        const ret: VariableObject[] = [];
        for (const name of names) {
            const childId = this.variableHandlesReverse.get(name);
            if (childId === undefined) {
                return undefined;
            }
            const child = this.variableHandles.get(childId);
            if (!(child instanceof VariableObject)) {
                return undefined;
            }
            ret.push(child);
        }
        return ret;
    }

    public async variablesChildrenRequest(
        response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments,
        miDebugger: MI2, session: GDBDebugSession): Promise<void> {
        response.body = { variables: [] };
        if (!args.variablesReference) {
            // This should only be called to expand additional variable for a valid parent
            session.sendResponse(response);
            return;
        }
        const id = this.variableHandles.get(args.variablesReference);
        if (typeof id === 'object') {
            if (id instanceof VariableObject) {
                const pVar = id;

                // Variable members
                let children: VariableObject[];
                const childMap: { [name: string]: number } = {};
                try {
                    let vars = [];
                    const ranged = Number.isInteger(args.start) && args.start >= 0
                        && Number.isInteger(args.count) && args.count > 0;
                    children = ranged
                        ? this.getCachedRangeChildren(pVar, args.start, args.count)
                        : this.getCachedChilren(pVar);
                    if (children) {
                        for (const child of children) {
                            vars.push(child.toProtocolVariable());
                        }
                    } else {
                        children = await miDebugger.varListChildren(
                            args.variablesReference, id.name,
                            ranged ? args.start : undefined,
                            ranged ? args.start + args.count : undefined
                        );
                        if (ranged) {
                            pVar.rangeChildren[`${args.start}:${args.count}`] = children.map((child) => child.name);
                        } else {
                            pVar.children = {};
                        }
                        for (const child of children) {
                            this.variableParents.set(child.name, { parent: pVar.name, key: String(child.exp) });
                        }
                        await this.classifyChildren(miDebugger, children);
                        vars = children.map((child) => {
                            const varId = this.findOrCreateVariable(child);
                            child.id = varId;
                            if (/^\d+$/.test(child.exp)) {
                                child.fullExp = `${pVar.fullExp || pVar.exp}[${child.exp}]`;
                            } else {
                                let suffix = '.' + child.exp;                   // A normal suffix
                                if (child.exp.startsWith('<anonymous')) {       // We can have duplicates!!
                                    const prev = childMap[child.exp];
                                    if (prev) {
                                        childMap[child.exp] = prev + 1;
                                        child.exp += '#' + prev.toString(10);
                                    }
                                    childMap[child.exp] = 1;
                                    suffix = '';    // Anonymous ones don't have a suffix. Have to use parent name
                                } else {
                                    // The full-name is not always derivable from the parent and child info. Esp. children
                                    // of anonymous stuff. Might as well store all of them or set-value will not work.
                                    pVar.children[child.exp] = child.name;
                                }
                                child.fullExp = `${pVar.fullExp || pVar.exp}${suffix}`;
                            }
                            return child.toProtocolVariable();
                        });
                    }

                    response.body = {
                        variables: vars
                    };
                    session.sendResponse(response);
                } catch (err) {
                    session.sendErrorResponsePub(response, 1, `Could not expand variable: ${err}`);
                }
            } else if (id instanceof ExtendedVariable) {
                const variables: DebugProtocol.Variable[] = [];

                const varReq = id;
                if (varReq.options.arg) {
                    const strArr = [];
                    let argsPart = true;
                    let arrIndex = 0;
                    const submit = () => {
                        response.body = {
                            variables: strArr
                        };
                        session.sendResponse(response);
                    };
                    const addOne = async () => {
                        const variable = await miDebugger.evalExpression(JSON.stringify(`${varReq.name}+${arrIndex})`), -1, -1);
                        try {
                            const expanded = expandValue(this.createVariable.bind(this), variable.result('value'), varReq.name, variable);
                            if (!expanded) {
                                session.sendErrorResponsePub(response, 15, 'Could not expand variable');
                            } else {
                                if (typeof expanded === 'string') {
                                    if (expanded === '<nullptr>') {
                                        if (argsPart) {
                                            argsPart = false;
                                        } else {
                                            return submit();
                                        }
                                    } else if (expanded[0] !== '"') {
                                        strArr.push({
                                            name: '[err]',
                                            value: expanded,
                                            variablesReference: 0
                                        });
                                        return submit();
                                    }
                                    strArr.push({
                                        name: `[${(arrIndex++)}]`,
                                        value: expanded,
                                        variablesReference: 0
                                    });
                                    addOne();
                                } else {
                                    strArr.push({
                                        name: '[err]',
                                        value: expanded,
                                        variablesReference: 0
                                    });
                                    submit();
                                }
                            }
                        } catch (e) {
                            session.sendErrorResponsePub(response, 14, `Could not expand variable: ${e}`);
                        }
                    };
                    addOne();
                } else {
                    session.sendErrorResponsePub(response, 13, `Unimplemented variable request options: ${JSON.stringify(varReq.options)}`);
                }
            } else {
                response.body = {
                    variables: id
                };
                session.sendResponse(response);
            }
        } else {
            response.body = {
                variables: []
            };
            session.sendResponse(response);
        }
    }
}

export class LiveWatchMonitor {
    public miDebugger: MI2 | undefined;
    protected varHandler: VariablesHandler;
    private engine: LiveMemoryEngine | undefined;
    private writer: LiveWatchWriter | undefined;
    private matrixReader: LiveMatrixReader | undefined;
    private matrixRequests: LiveMatrixRequest[] = [];
    private legacySubscription: ReadonlySet<string> | undefined;
    private requestTail: Promise<unknown> = Promise.resolve();

    /** Serialize sampling, cache deletion and writes; discovery can keep progressing. */
    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = this.requestTail.then(task);
        this.requestTail = result.catch(() => undefined);
        return result;
    }

    private memoryOptions: LiveMemoryOptions = {
        mode: 'auto', maxBlockBytes: 1024, mergeGapBytes: 256, maxDepth: 8, extraRamRegions: []
    };

    constructor(private mainSession: GDBDebugSession) {
        this.varHandler = new VariablesHandler(
            (): boolean => false,
            (r: DebugProtocol.Response, a: any) => { }
        );
    }

    public setupEvents(mi2: MI2) {
        this.miDebugger = mi2;
        this.matrixRequests = [];
        this.engine = new LiveMemoryEngine(this.varHandler, mi2, () => this.memoryOptions, this.varHandler.getTypeResolver(mi2));
        this.writer = new LiveWatchWriter(mi2, this.varHandler.getTypeResolver(mi2), () => !this.quitting);
        this.matrixReader = new LiveMatrixReader(mi2, this.varHandler.getTypeResolver(mi2),
            (name) => this.varHandler.matrixStoragePath(name));
        this.miDebugger.on('quit', this.quitEvent.bind(this));
        this.miDebugger.on('exited-normally', this.quitEvent.bind(this));
        this.miDebugger.on('msg', (type: string, msg: string) => {
            this.mainSession.handleMsg(type, 'LiveGDB: ' + msg);
        });

        /*
        Yes, we get all of these events and they seem to be harlmess
        const otherEvents = [
            'stopped',
            'watchpoint',
            'watchpoint-scope',
            'step-end',
            'step-out-end',
            'signal-stop',
            'running',
            'continue-failed',
            'thread-created',
            'thread-exited',
            'thread-selected',
            'thread-group-exited'
        ];
        for (const ev of otherEvents) {
            this.miDebugger.on(ev, (arg) => {
                this.mainSession.handleMsg(
                    'stderr', `Internal Error: Live watch GDB session received an unexpected event '${ev}' with arg ${arg?.toString() ?? '<empty>'}\n`);
            });
        }
        */
    }

    protected quitEvent() {
        // this.miDebugger = undefined;
    }

    public evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        return new Promise<void>((resolve) => {
            args.frameId = undefined;       // We don't have threads or frames here. We always evaluate in global context
            this.varHandler.evaluateRequest(response, args, this.miDebugger, this.mainSession, true).finally(() => {
                if (this.mainSession.args.showDevDebugOutput) {
                    this.mainSession.handleMsg('log', `LiveGBD: Evaluated ${args.expression}\n`);
                }
                resolve();
            });
        });
    }

    public async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        return this.varHandler.variablesChildrenRequest(response, args, this.miDebugger, this.mainSession);
    }

    public setValue(args: { name: string; value: string }): Promise<LiveWriteResult> {
        return this.enqueue(async () => {
            const handle = this.varHandler.variableHandlesReverse.get(args?.name);
            const variable = handle === undefined ? undefined : this.varHandler.variableHandles.get(handle);
            if (this.quitting || !this.writer) { throw new Error('Live Watch 调试会话已结束'); }
            if (!(variable instanceof VariableObject) || typeof args.value !== 'string') {
                throw new Error('变量已经失效，请等待刷新后重新编辑');
            }
            const result = await this.writer.write(variable.name, args.value);
            this.varHandler.cachedChangeList = undefined;
            return result;
        });
    }

    // Calling this will also enable caching for the future of the session
    public async refreshLiveCache(args: RefreshAllArguments): Promise<LiveCacheRefreshResult> {
        return this.enqueue(async () => {
            const started = Date.now();
            const result = await this.refreshLiveCacheInternal(args);
            if (args.deleteAll) {
                this.matrixReader?.clear();
                this.matrixRequests = [];
                return result;
            }
            if (args.matrices) { this.matrixRequests = args.matrices.slice(0, 64); }
            const matrices: LiveMatrixSample[] = [];
            for (const request of this.matrixRequests) {
                const handle = this.varHandler.variableHandlesReverse.get(request.id);
                const variable = handle === undefined ? undefined : this.varHandler.variableHandles.get(handle);
                if (variable instanceof VariableObject && variable.matrix && this.matrixReader) {
                    matrices.push(await this.matrixReader.sample(request, variable.matrix));
                } else {
                    matrices.push({ name: request.id, values: [], error: '矩阵变量已失效，请重新开始调试' });
                }
            }
            return { ...result, matrices, readMs: Date.now() - started };
        });
    }

    private async refreshLiveCacheInternal(args: RefreshAllArguments): Promise<LiveCacheRefreshResult> {
        if (args.deleteAll) {
            await this.varHandler.clearCachedVars(this.miDebugger);
            this.engine?.clear();
            this.legacySubscription = undefined;
            return { changes: [], rebuild: true, readMs: 0 };
        }
        if (args.options) {
            this.memoryOptions = { ...this.memoryOptions, ...args.options };
        }
        if (args.subscription) { this.legacySubscription = new Set(args.subscription.map((node) => node.id)); }
        if (!this.engine || !this.miDebugger) {
            return this.varHandler.refreshCachedChangeList(this.miDebugger, true, this.legacySubscription);
        }
        if (args.subscription && (args.revision !== undefined)) {
            this.engine.setSubscription(args.revision, args.subscription);
        }
        const frame = await this.engine.sample();
        if (frame.stats.phase === 'prepare') {
            try {
                const current = await this.varHandler.refreshCachedChangeList(this.miDebugger, true, this.legacySubscription);
                return { ...current, frame, mode: 'prepare', preparing: true };
            } catch (error) {
                frame.stats.errors.push(`准备期间逐字段读取失败：${String(error)}`);
                return { changes: [], rebuild: false, readMs: 0, frame, mode: 'prepare', preparing: true };
            }
        }
        if (frame.useLegacy) {
            const legacy = await this.varHandler.refreshCachedChangeList(this.miDebugger, true, this.legacySubscription);
            return { ...legacy, frame, mode: 'legacy' };
        }
        const changes = frame.values
            .filter((value) => (value.status === 'ok') && (value.value !== undefined))
            .map((value) => ({ name: value.id, value: value.value }));
        const unavailable = frame.values
            .filter((value) => value.status === 'unavailable')
            .map((value) => ({ name: value.id, error: value.error }));
        return {
            changes, rebuild: false, readMs: frame.stats.readMs,
            unavailable, frame, mode: 'bulk'
        };
    }

    private quitting = false;
    public quit() {
        try {
            if (!this.quitting) {
                this.quitting = true;
                this.miDebugger.stop(true);
            }
        } catch (e) {
            console.error('LiveWatchMonitor.quit', e);
        }
    }
}

interface RefreshAllArguments {
    // Delete all gdb variables and the cache. This should be done when a live expression is deleted,
    // but otherwise, it is not needed
    deleteAll: boolean;
    /** Subscription snapshot; only sent when the frontend revision changed. */
    subscription?: LiveSubscriptionNode[];
    revision?: number;
    options?: Partial<LiveMemoryOptions>;
    matrices?: LiveMatrixRequest[];
}
