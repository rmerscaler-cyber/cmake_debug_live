import { MINode } from './mi_parse';
import { DebugProtocol } from '@vscode/debugprotocol';
import { toStringDecHexOctBin } from '../common';
import { hexFormat } from '../frontend/utils';
import { LiveMatrixShape } from '../live-matrix';

export interface OurSourceBreakpoint extends DebugProtocol.SourceBreakpoint {
    file?: string;
    raw?: string;       // Used for function name as well and old style address breakpoints
    isFunction?: boolean;
    isTemporary?: boolean;
    // What we get from gdb below
    address?: string;
    number?: number;
    hwOpt?: string; // The gdb MI argument to use for hardware breakpoint allocation
}

export interface OurInstructionBreakpoint extends DebugProtocol.InstructionBreakpoint {
    address: number;
    number: number;
    htOpt?: string; // The gdb MI argument to use for hardware breakpoint allocation
}

export interface OurDataBreakpoint extends DebugProtocol.DataBreakpoint {
    number?: number;
}

export interface Stack {
    level: number;
    address: string;
    function: string;
    fileName: string;
    file: string;
    line: number;
}

export interface Variable {
    name: string;
    valueStr: string;
    type: string;
    raw?: any;
}

export interface IBackend {
    start(cwd: string, init: string[]): Thenable<any>;
    connect(target: string[]): Thenable<any>;
    stop();
    detach();
    interrupt(arg: string): Thenable<boolean>;
    continue(threadId: number): Thenable<boolean>;
    next(threadId: number, instruction: boolean): Thenable<boolean>;
    step(threadId: number, instruction: boolean): Thenable<boolean>;
    stepOut(threadId: number): Thenable<boolean>;
    addBreakPoint(breakpoint: OurSourceBreakpoint): Promise<OurSourceBreakpoint>;
    removeBreakpoints(breakpoints: number[]): Promise<boolean>;
    getStack(threadId: number, startLevel: number, maxLevels: number): Thenable<Stack[]>;
    getStackVariables(thread: number, frame: number): Thenable<Variable[]>;
    evalExpression(name: string, threadId: number, frameId: number): Thenable<any>;
    isRunning(): boolean;
    changeVariable(name: string, rawValue: string): Thenable<any>;
    examineMemory(from: number, to: number): Thenable<any>;
}

function miBoolean(value: any): boolean {
    return value === true || value === 'true' || value === '1';
}

const scalarTypeRegex = new RegExp(
    '^(?:bool|_Bool|char|signed char|unsigned char|short|short int|int|signed|unsigned|'
    + 'long|long int|long long|float|double|long double|void)\\b');

/** Cheap syntactic classification; the adapter overrides it with resolved kinds. */
export function syntacticTypeKind(type: string): string {
    const text = String(type || '').trim();
    if (!text) { return 'unknown'; }
    if (/\(\s*\*\s*[A-Za-z_]\w*\s*\)\s*\(/.test(text) || /\(\s*\*\s*\)\s*\(/.test(text)) {
        return 'function-pointer';
    }
    if (/\(\s*\*/.test(text)) { return 'pointer'; }      // pointer to array/function
    if (/\[[^\]]*\]\s*$/.test(text)) { return 'array'; }
    if (/^(struct|union)\b/.test(text)) { return text.startsWith('union') ? 'union' : 'struct'; }
    if (/^enum\b/.test(text)) { return 'enum'; }
    if (/\*$/.test(text)) { return 'pointer'; }
    if (scalarTypeRegex.test(text)) { return 'scalar'; }
    if (/^[A-Za-z_]\w*$/.test(text)) { return 'typedef'; }
    return 'aggregate';
}

export class VariableObject {
    public name: string;
    public curDisplayName: string;
    public exp: string;
    public numchild: number;
    public type: string;
    /** Syntactic/resolved classification ('pointer', 'array', 'struct', ...). */
    public typeKind: string;
    public matrix: LiveMatrixShape | undefined;
    public value: string;
    public threadId: string;
    public frozen: boolean;
    public dynamic: boolean;
    public displayhint: string;
    public hasMore: boolean;
    public id: number;
    public fullExp: string;
    public parent: number;      // Variable Reference
    public children: { [name: string]: string };  // Field-name to Gdb-variable map
    public rangeChildren: { [range: string]: string[] };
    constructor(p: number, node: any) {
        this.parent = p;
        this.name = MINode.valueOf(node, 'name');
        this.curDisplayName = this.name;
        this.exp = MINode.valueOf(node, 'exp');
        this.numchild = parseInt(MINode.valueOf(node, 'numchild'));
        this.type = MINode.valueOf(node, 'type');
        this.typeKind = '';
        this.value = MINode.valueOf(node, 'value');
        this.threadId = MINode.valueOf(node, 'thread-id');
        this.frozen = miBoolean(MINode.valueOf(node, 'frozen'));
        this.dynamic = miBoolean(MINode.valueOf(node, 'dynamic'));
        this.displayhint = MINode.valueOf(node, 'displayhint');
        this.children = {};
        this.rangeChildren = {};
        // TODO: use has_more when it's > 0
        this.hasMore = miBoolean(MINode.valueOf(node, 'has_more'));
    }

    public createToolTip(name: string, value: string): string {
        let ret = this.type;
        if (this.isCompound()) {
            return ret;
        }

        let val = 0;
        if ((/^0[xX][0-9A-Fa-f]+/.test(value)) || /^[-]?[0-9]+/.test(value)) {
            val = parseInt(value.toLowerCase());

            ret += ' ' + name + ';\n';
            ret += toStringDecHexOctBin(val);
        }
        return ret;
    }

    public applyChanges(node: MINode) {
        const value = MINode.valueOf(node, 'value');
        if (value !== undefined) {
            this.value = value;
        }
        /*
        if (this.value === undefined) {
            this.value = def;
        }
        */
        const typeChanged = MINode.valueOf(node, 'type_changed');
        if (typeChanged === 'true') {
            this.type = MINode.valueOf(node, 'new_type') || this.type;
            this.clearChildrenCache();
        }
        const newNumChildren = MINode.valueOf(node, 'new_num_children');
        if (newNumChildren !== undefined) {
            const count = parseInt(newNumChildren, 10);
            if (Number.isFinite(count) && count !== this.numchild) {
                this.numchild = count;
                this.clearChildrenCache();
            }
        }
        const dynamic = MINode.valueOf(node, 'dynamic');
        if (dynamic !== undefined) {
            this.dynamic = miBoolean(dynamic);
        }
        const displayhint = MINode.valueOf(node, 'displayhint');
        if (displayhint !== undefined) {
            this.displayhint = displayhint;
        }
        const hasMore = MINode.valueOf(node, 'has_more');
        if (hasMore !== undefined) {
            this.hasMore = miBoolean(hasMore);
        }
    }

    public clearChildrenCache() {
        this.children = {};
        this.rangeChildren = {};
    }

    public isCompound(): boolean {
        return this.numchild > 0
            || this.value === '{...}'
            || (this.dynamic && (this.displayhint === 'array' || this.displayhint === 'map'));
    }

    public toProtocolVariable(newName?: string): DebugProtocol.Variable {
        const res: DebugProtocol.Variable = {
            name: newName || this.exp,
            evaluateName: this.fullExp || this.exp,
            value: (this.value === void 0) ? '<unknown>' : this.value,
            type: this.type,
            presentationHint: {
                kind: this.displayhint
            },
            variablesReference: this.isCompound() ? this.id : 0
        };
        res['gdbVarName'] = this.name;
        res['matrix'] = this.matrix;
        if (this.type) { res['rawType'] = this.type; }
        res['typeKind'] = this.typeKind || syntacticTypeKind(this.type);
        if (/\[[^\]]+\]$/.test(this.type) && Number.isFinite(this.numchild)) {
            res.indexedVariables = this.numchild;
        }
        this.tryAddMemoryReference(res);
        this.curDisplayName = res.name;

        res.type = this.createToolTip(res.name, res.value);      // This ends up becoming a tool-tip
        return res;
    }

    public toProtocolEvaluateResponseBody(): DebugProtocol.EvaluateResponse['body'] {
        const res: DebugProtocol.EvaluateResponse['body'] = {
            result: this.value,
            type: this.type,
            presentationHint: {
                kind: this.displayhint
            },
            variablesReference: this.isCompound() ? this.id : 0
        };
        res['gdbVarName'] = this.name;
        res['matrix'] = this.matrix;
        if (this.type) { res['rawType'] = this.type; }
        res['typeKind'] = this.typeKind || syntacticTypeKind(this.type);
        if (/\[[^\]]+\]$/.test(this.type) && Number.isFinite(this.numchild)) {
            res.indexedVariables = this.numchild;
        }
        this.tryAddMemoryReference(res);
        return res;
    }

    private tryAddMemoryReference(result: object): void {
        if ((this.numchild > 0 || this.type === 'void *')
            && this.value.startsWith('0x')) {
            result['memoryReference'] = hexFormat(parseInt(this.value));
        }
    }
}

// from https://gist.github.com/justmoon/15511f92e5216fa2624b#gistcomment-1928632
export interface MIError extends Error {
    readonly name: string;
    readonly message: string;
    readonly source: string;
}

export interface MIErrorConstructor {
    readonly prototype: MIError;
    new (message: string, source: string): MIError;
}

export const MIError: MIErrorConstructor = class MIError {
    public readonly name: string;
    public readonly message: string;
    public readonly source: string;
    public constructor(message: string, source: string) {
        Object.defineProperty(this, 'name', {
            get: () => this.constructor.name
        });
        Object.defineProperty(this, 'message', {
            get: () => message
        });
        Object.defineProperty(this, 'source', {
            get: () => source
        });
        Error.captureStackTrace(this, this.constructor);
    }

    public toString() {
        return `${this.message} (from ${this.source})`;
    }
} as any;
Object.setPrototypeOf(MIError as any, Object.create(Error.prototype));
MIError.prototype.constructor = MIError;
