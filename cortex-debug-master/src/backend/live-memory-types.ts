/**
 * Type classification and `ptype /o` layout parsing for the live-memory sampler.
 *
 * The parser is pure text processing (unit tested against real H7 `ptype /o`
 * fixtures). GDB queries resolve typedefs, enums, signedness and sizes; every
 * result is cached per session by the owning engine.
 */

export interface TypeQuery {
    /** Runs a GDB CLI command and returns its stdout text. */
    console(command: string): Promise<string>;
    /** Evaluates an expression and returns its value text (may be empty). */
    evaluate(expression: string): Promise<string>;
}

export type ScalarKind = 'signed' | 'unsigned' | 'float' | 'bool' | 'enum' | 'pointer' | 'function-pointer';

export interface ScalarType {
    kind: ScalarKind;
    byteSize: number;
    signed?: boolean;
    /** decimal text -> enumerator name */
    enumValues?: Map<string, string>;
    pointeeTypeText?: string;
    typeName: string;
}

export interface MemberLayout {
    name: string;
    byteOffset: number;
    byteSize: number;
    bitfield?: { bitOffset: number; bitSize: number };
    type: TypeLayout;
    arrayDims?: number[];
    anonymous?: boolean;
}

export interface AggregateType {
    kind: 'struct' | 'union';
    byteSize: number;
    members: MemberLayout[];
    typeName: string;
}

export type TypeLayout = ScalarType | AggregateType;

export function isAggregate(layout: TypeLayout | undefined): layout is AggregateType {
    return !!layout && (layout.kind === 'struct' || layout.kind === 'union');
}

export function isScalar(layout: TypeLayout | undefined): layout is ScalarType {
    return !!layout && !isAggregate(layout);
}

const scalarKeywords: { [name: string]: { kind: ScalarKind; byteSize: number; signed?: boolean } } = {
    'char': { kind: 'signed', byteSize: 1 },
    'signed char': { kind: 'signed', byteSize: 1 },
    'unsigned char': { kind: 'unsigned', byteSize: 1 },
    'short': { kind: 'signed', byteSize: 2 },
    'short int': { kind: 'signed', byteSize: 2 },
    'signed short': { kind: 'signed', byteSize: 2 },
    'signed short int': { kind: 'signed', byteSize: 2 },
    'unsigned short': { kind: 'unsigned', byteSize: 2 },
    'unsigned short int': { kind: 'unsigned', byteSize: 2 },
    'int': { kind: 'signed', byteSize: 4 },
    'signed': { kind: 'signed', byteSize: 4 },
    'signed int': { kind: 'signed', byteSize: 4 },
    'unsigned': { kind: 'unsigned', byteSize: 4 },
    'unsigned int': { kind: 'unsigned', byteSize: 4 },
    'long': { kind: 'signed', byteSize: 4 },
    'long int': { kind: 'signed', byteSize: 4 },
    'long long': { kind: 'signed', byteSize: 8 },
    'long long int': { kind: 'signed', byteSize: 8 },
    'unsigned long': { kind: 'unsigned', byteSize: 4 },
    'unsigned long int': { kind: 'unsigned', byteSize: 4 },
    'unsigned long long': { kind: 'unsigned', byteSize: 8 },
    'unsigned long long int': { kind: 'unsigned', byteSize: 8 },
    'float': { kind: 'float', byteSize: 4 },
    'double': { kind: 'float', byteSize: 8 },
    'long double': { kind: 'float', byteSize: 8 },
    'bool': { kind: 'bool', byteSize: 1 },
    '_Bool': { kind: 'bool', byteSize: 1 }
};

export function normalizeTypeText(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\b(const|volatile|restrict)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Keep C++ names intact even when GDB's selected frame uses the C language. */
export function gdbTypeName(text: string): string {
    const match = /^(?:(struct|union|class|enum)\s+)?(.+)$/.exec(text.trim());
    if (!match || !/::|</.test(match[2])) { return text; }
    const name = match[2].replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
    return `${match[1] ? match[1] + ' ' : ''}'${name}'`;
}

/** Returns array dimensions if the type text ends with `[..]` groups. */
export function arraySuffix(text: string): { base: string; dims: number[] } | undefined {
    const match = /^(.*?)\s*((?:\[\s*\d*\s*\])+)$/.exec(text);
    if (!match) { return undefined; }
    const dims: number[] = [];
    const dimRegex = /\[\s*(\d*)\s*\]/g;
    let dimMatch: RegExpExecArray;
    while ((dimMatch = dimRegex.exec(match[2]))) {
        dims.push(dimMatch[1] === '' ? 0 : parseInt(dimMatch[1], 10));
    }
    return { base: match[1].trim(), dims };
}

/** True when the top level of the declaration is a data pointer (not array). */
export function isPointerText(text: string): boolean {
    const t = normalizeTypeText(text);
    if (!t) { return false; }
    if (isFunctionPointerText(t)) { return false; }
    if (/\(\s*\*/.test(t)) { return true; }          // pointer to array/function
    if (arraySuffix(t)) { return false; }
    return /\*$/.test(t);
}

export function isFunctionPointerText(text: string): boolean {
    const t = normalizeTypeText(text);
    return /\(\s*\*\s*[A-Za-z_]\w*\s*\)\s*\(/.test(t) || /\(\s*\*\s*\)\s*\(/.test(t);
}

/* -------------------------------------------------------------------------- */
/* Raw `ptype /o` parsing (pure)                                              */
/* -------------------------------------------------------------------------- */

interface RawMember {
    name: string;
    byteOffset: number;
    byteSize: number;
    typeText: string;
    arrayDims?: number[];
    bitfield?: { bitOffset: number; bitSize: number };
    functionPointer?: boolean;
    inline?: RawAggregate;
    anonymous?: boolean;
}

interface RawAggregate {
    kind: 'struct' | 'union';
    byteSize: number;
    members: RawMember[];
}

const memberLineRegex = /^\/\*\s*(\d+)\s*(?::\s*(\d+)\s*)?\|\s*(\d+)\s*\*\/\s*(.*)$/;
const totalSizeRegex = /^\/\*\s*total size \(bytes\):\s*(\d+)\s*\*\/$/;
const holeRegex = /^\/\*\s*XXX\b.*\*\/$/;

interface RawMemberLine {
    byteOffset: number;
    bitOffset?: number;
    byteSize: number;
    decl: string;
}

function parseMemberDecl(decl: string): {
    name: string;
    typeText: string;
    arrayDims?: number[];
    bitSize?: number;
    functionPointer?: boolean;
} | undefined {
    let text = decl.trim();
    if (text.endsWith(';')) { text = text.slice(0, -1).trim(); }
    if (!text) { return undefined; }

    let bitSize: number | undefined;
    const bitfield = /^(.+?)\s*:\s*(\d+)$/.exec(text);
    if (bitfield) {
        text = bitfield[1].trim();
        bitSize = parseInt(bitfield[2], 10);
    }

    // Function pointer, optionally an array of them:
    //   void (*fn)(int)   /   void (*fn[4])(int)
    const fnPointer = /^(.*?)\(\s*\*\s*([A-Za-z_]\w*)?\s*((?:\[\s*\d*\s*\])*)\s*\)\s*(\(.*\))$/.exec(text);
    if (fnPointer) {
        return {
            name: fnPointer[2] || '',
            typeText: `${fnPointer[1]}${fnPointer[4]}`.trim(),
            arrayDims: parseDims(fnPointer[3]),
            bitSize,
            functionPointer: true
        };
    }

    const array = /^(.*?)\b([A-Za-z_]\w*)\s*((?:\[\s*\d*\s*\])+)$/.exec(text);
    if (array) {
        return { name: array[2], typeText: array[1].trim(), arrayDims: parseDims(array[3]), bitSize };
    }

    const plain = /^(.*?)\b([A-Za-z_]\w*)$/.exec(text);
    if (plain) {
        return { name: plain[2], typeText: plain[1].trim(), bitSize };
    }
    return undefined;
}

function parseDims(text: string): number[] | undefined {
    const dims: number[] = [];
    const dimRegex = /\[\s*(\d*)\s*\]/g;
    let dimMatch: RegExpExecArray;
    while ((dimMatch = dimRegex.exec(text))) {
        dims.push(dimMatch[1] === '' ? 0 : parseInt(dimMatch[1], 10));
    }
    return dims.length ? dims : undefined;
}

interface BlockResult {
    members: RawMember[];
    byteSize: number;
    endIndex: number;
}

/**
 * Recursive block parser. `lines[startIndex]` is the first content line after
 * an opening `{`; parsing stops at the matching closing brace.
 */
function parseBlock(lines: string[], startIndex: number, baseOffset = 0): BlockResult | undefined {
    const members: RawMember[] = [];
    let byteSize: number | undefined;
    let index = startIndex;
    for (; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed) { continue; }
        if (trimmed.startsWith('}')) {
            if (byteSize === undefined) { return undefined; }
            return { members, byteSize, endIndex: index };
        }
        const total = totalSizeRegex.exec(trimmed);
        if (total) {
            byteSize = parseInt(total[1], 10);
            continue;
        }
        if (holeRegex.test(trimmed)) { continue; }
        const member = memberLineRegex.exec(trimmed);
        if (!member) { continue; }
        const absoluteOffset = parseInt(member[1], 10);
        if (absoluteOffset < baseOffset) { return undefined; }
        const item: RawMemberLine = {
            // GDB prints offsets from the outermost object even inside an
            // inline struct. Layout members must be relative to their parent.
            byteOffset: absoluteOffset - baseOffset,
            bitOffset: member[2] !== undefined ? parseInt(member[2], 10) : undefined,
            byteSize: parseInt(member[3], 10),
            decl: member[4].trim()
        };

        const inlineMatch = /^(struct|union)\b.*\{\s*$/.test(item.decl);
        if (inlineMatch) {
            const nested = parseBlock(lines, index + 1, absoluteOffset);
            if (!nested) { return undefined; }
            const closing = /^}\s*([A-Za-z_]\w*)?\s*((?:\[\s*\d*\s*\])*)\s*;?$/.exec(lines[nested.endIndex].trim());
            const name = closing?.[1] || '';
            const dims = closing?.[2] ? parseDims(closing[2]) : undefined;
            members.push({
                name,
                byteOffset: item.byteOffset,
                byteSize: item.byteSize,
                typeText: item.decl.replace(/\s*\{\s*$/, '').trim(),
                arrayDims: dims,
                inline: {
                    kind: /^union\b/.test(item.decl) ? 'union' : 'struct',
                    byteSize: nested.byteSize,
                    members: nested.members
                },
                anonymous: !name
            });
            index = nested.endIndex;
            continue;
        }

        const decl = parseMemberDecl(item.decl);
        if (!decl) { return undefined; }
        members.push({
            name: decl.name,
            byteOffset: item.byteOffset,
            byteSize: item.byteSize,
            typeText: decl.typeText,
            arrayDims: decl.arrayDims,
            bitfield: item.bitOffset !== undefined
                ? { bitOffset: item.bitOffset, bitSize: decl.bitSize || 1 }
                : undefined,
            functionPointer: decl.functionPointer,
            anonymous: !decl.name
        });
    }
    return undefined;
}

export interface ParsedAggregate {
    kind: 'struct' | 'union';
    byteSize: number;
    members: RawMember[];
    typeName: string;
}

/**
 * Parses `ptype /o <aggregate>` output. Returns undefined when the text does
 * not match the expected GDB layout format; callers must fall back instead of
 * guessing offsets.
 */
export function parseAggregatePtypeOutput(text: string, typeName: string): ParsedAggregate | undefined {
    const lines = text.replace(/\r/g, '').split('\n');
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { continue; }
        if (/^type\s*=\s*(?:struct|union)\b/.test(line)) {
            headerIndex = i;
            break;
        }
        // Skip console noise/warnings that may precede the type.
        if (/^(?:&|warning:)/i.test(line) || /^this normally/i.test(line)) { continue; }
    }
    if (headerIndex < 0) { return undefined; }
    const header = lines[headerIndex].trim();
    const kind = /^type\s*=\s*union\b/.test(header) ? 'union' : 'struct';

    let bodyStart = headerIndex + 1;
    if (!/\{\s*$/.test(header)) {
        // The opening brace may sit on the following line.
        if (lines[bodyStart] && lines[bodyStart].trim() === '{') {
            bodyStart++;
        } else {
            return undefined;
        }
    }
    const parsed = parseBlock(lines, bodyStart);
    if (!parsed || parsed.members.length === 0) { return undefined; }
    return { kind, byteSize: parsed.byteSize, members: parsed.members, typeName };
}

/* -------------------------------------------------------------------------- */
/* Async resolver                                                             */
/* -------------------------------------------------------------------------- */

function memberFromRaw(raw: RawMember, type: TypeLayout, dims?: number[]): MemberLayout {
    return {
        name: raw.name,
        byteOffset: raw.byteOffset,
        byteSize: raw.byteSize,
        bitfield: raw.bitfield,
        type,
        arrayDims: dims || raw.arrayDims,
        anonymous: raw.anonymous
    };
}

/** Async resolver; caches by normalized type text for the owning session. */
export class TypeResolver {
    private readonly cache = new Map<string, TypeLayout | undefined>();
    private readonly declarations = new Map<string, Promise<string | undefined>>();
    private readonly ptypes = new Map<string, Promise<string>>();
    private readonly kinds = new Map<string, Promise<string>>();
    private pointerSize: number | undefined;
    private charSigned: boolean | undefined;

    constructor(private readonly query: TypeQuery) { }

    public clear(): void {
        this.cache.clear();
        this.declarations.clear();
        this.ptypes.clear();
        this.kinds.clear();
        this.pointerSize = undefined;
        this.charSigned = undefined;
    }

    public async getPointerSize(): Promise<number> {
        if (this.pointerSize === undefined) {
            const value = await this.query.evaluate('sizeof(void *)');
            this.pointerSize = /^\d+/.exec(value) ? parseInt(value, 10) : 4;
        }
        return this.pointerSize;
    }

    public async isCharSigned(): Promise<boolean> {
        if (this.charSigned === undefined) {
            const value = await this.query.evaluate('((char)-1) < 0');
            this.charSigned = value.trim() !== '0';
        }
        return this.charSigned;
    }

    public async declaredType(typeText: string): Promise<string | undefined> {
        let current = normalizeTypeText(typeText);
        const visited = new Set<string>();
        // whatis /r can remove only one typedef layer (M4 -> Matrix4d -> Matrix).
        // Keep each query cached and stop at concrete declarations or cycles.
        for (let depth = 0; depth < 16 && !visited.has(current); depth++) {
            visited.add(current);
            const declared = await this.whatisType(current);
            if (!declared) { return undefined; }
            current = normalizeTypeText(declared);
            if (this.directKind(current)) { return declared; }
        }
        return current;
    }

    /** Classify a typedef without resolving any of its member layouts. */
    public async classifyTypeText(typeText: string): Promise<string> {
        const normalized = normalizeTypeText(typeText);
        const direct = this.directKind(normalized);
        if (direct) { return direct; }
        let pending = this.kinds.get(normalized);
        if (!pending) {
            pending = (async () => {
                const declared = await this.declaredType(normalized);
                if (declared) {
                    const kind = this.directKind(normalizeTypeText(declared));
                    if (kind) { return kind; }
                }
                // Older GDB versions can lack whatis /r. Inspect only the
                // declaration header; never recursively resolve its members.
                const text = await this.ptype(normalized);
                const header = /^(?:\/\*[^\n]*?\*\/\s*)?type\s*=\s*(.+)$/m.exec(text.replace(/\r/g, ''))?.[1];
                return this.directKind(normalizeTypeText(header || '')) || 'unknown';
            })();
            this.kinds.set(normalized, pending);
        }
        return pending;
    }

    private directKind(text: string): string | undefined {
        if (isFunctionPointerText(text)) { return 'function-pointer'; }
        if (isPointerText(text)) { return 'pointer'; }
        if (arraySuffix(text)) { return 'array'; }
        if (/^class\b/.test(text)) { return 'struct'; }
        if (/^(struct|union|enum)\b/.test(text)) { return text.split(' ')[0]; }
        if (scalarKeywords[text]) { return 'scalar'; }
        return undefined;
    }

    /** paths restrict recursion to subscribed leaves; undefined resolves all members. */
    public async resolveTypeText(typeText: string, paths?: string[][]): Promise<TypeLayout | undefined> {
        return this.resolveType(typeText, paths, new Set());
    }

    private async resolveType(typeText: string, paths: string[][] | undefined, ancestors: ReadonlySet<string>): Promise<TypeLayout | undefined> {
        const normalized = normalizeTypeText(typeText);
        if (!normalized) { return undefined; }
        // A C struct tag and a global variable can share the same spelling.
        // In some GDB language contexts whatis returns A -> B -> A. Awaiting
        // cached declarations forever would starve the event loop and prevent
        // even unrelated MI responses from being processed.
        if (ancestors.has(normalized)) { return undefined; }
        const key = paths === undefined
            ? normalized
            : `${normalized}:${JSON.stringify(paths.map((path) => JSON.stringify(path)).sort())}`;
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }
        const next = new Set(ancestors);
        next.add(normalized);
        const layout = await this.resolveUncached(normalized, paths, next);
        if (layout) { this.cache.set(key, layout); }
        return layout;
    }

    private async resolveUncached(normalized: string, paths: string[][] | undefined, ancestors: ReadonlySet<string>): Promise<TypeLayout | undefined> {
        const pointerSize = await this.getPointerSize();

        const array = arraySuffix(normalized);
        if (array) {
            return this.resolveType(array.base, paths?.map((path) => path.slice(array.dims.length)), ancestors);
        }
        if (isFunctionPointerText(normalized)) {
            return { kind: 'function-pointer', byteSize: pointerSize, typeName: normalized };
        }
        if (isPointerText(normalized)) {
            return {
                kind: 'pointer',
                byteSize: pointerSize,
                typeName: normalized,
                pointeeTypeText: normalized.replace(/\*+\s*$/, '').trim()
            };
        }

        const direct = scalarKeywords[normalized];
        if (direct) {
            if (normalized === 'char') {
                const signed = await this.isCharSigned();
                return { kind: signed ? 'signed' : 'unsigned', byteSize: 1, signed, typeName: normalized };
            }
            return {
                kind: direct.kind,
                byteSize: direct.byteSize,
                signed: direct.kind === 'signed' ? true : undefined,
                typeName: normalized
            };
        }

        // GDB's `ptype /o <typedef>` expands a typedef-to-pointer into the
        // pointee struct, which would silently turn pointer members into
        // embedded aggregates (the H7 `motor_handle_t` bug). `whatis /r`
        // reports the declared type, so classify with it first and only parse
        // a layout when the declaration itself is an aggregate or enum.
        const declaredRaw = await this.whatisType(normalized);
        if (declaredRaw) {
            const declared = normalizeTypeText(declaredRaw);
            if (isFunctionPointerText(declared)) {
                return { kind: 'function-pointer', byteSize: pointerSize, typeName: normalized };
            }
            if (isPointerText(declared)) {
                return {
                    kind: 'pointer',
                    byteSize: pointerSize,
                    typeName: normalized,
                    pointeeTypeText: declared.replace(/\*+\s*$/, '').trim()
                };
            }
            if (/^(?:struct|union|enum)\b/.test(declared)) {
                const text = await this.ptype(normalized);
                return this.parsePtypeText(text, normalized, paths, ancestors);
            }
            if (declared !== normalized) {
                // Only recurse into a concrete scalar or array declaration.
                // An unqualified struct tag can also name a global expression;
                // ptype on the original typedef expands it without that ambiguity.
                if (scalarKeywords[declared] || arraySuffix(declared)) {
                    return this.resolveType(declared, paths, ancestors);
                }
                const text = await this.ptype(normalized);
                return this.parsePtypeText(text, normalized, paths, ancestors);
            }
        }

        const text = await this.ptype(normalized);
        return this.parsePtypeText(text, normalized, paths, ancestors);
    }

    private async whatisType(name: string): Promise<string | undefined> {
        let pending = this.declarations.get(name);
        if (!pending) {
            pending = this.query.console(`whatis /r ${gdbTypeName(name)}`).then((text) => {
                const match = /^type\s*=\s*(.+)$/m.exec(text.replace(/\r/g, ''));
                return match ? match[1].trim() : undefined;
            }).catch((error) => {
                this.declarations.delete(name);
                throw error;
            });
            this.declarations.set(name, pending);
        }
        return pending;
    }

    private ptype(name: string): Promise<string> {
        let pending = this.ptypes.get(name);
        if (!pending) {
            pending = this.query.console(`ptype /o ${gdbTypeName(name)}`).catch((error) => {
                this.ptypes.delete(name);
                throw error;
            });
            this.ptypes.set(name, pending);
        }
        return pending;
    }

    private async parsePtypeText(
        text: string, typeName: string, paths: string[][] | undefined, ancestors: ReadonlySet<string>
    ): Promise<TypeLayout | undefined> {
        const clean = text.replace(/\r/g, '');
        if (/\bNo symbol\b/.test(clean)) { return undefined; }
        const firstType = /^type\s*=\s*(.+)$/m.exec(clean)?.[1]?.trim();
        if (!firstType) { return undefined; }

        if (/^(?:struct|union)\b/.test(firstType) && /\{\s*$/.test(firstType)) {
            const parsed = parseAggregatePtypeOutput(clean, typeName);
            if (!parsed) { return undefined; }
            return this.buildAggregate(parsed, paths);
        }
        if (/^enum\b/.test(firstType)) {
            return this.parseEnum(clean, typeName);
        }
        if (normalizeTypeText(firstType) !== normalizeTypeText(typeName)) {
            return this.resolveType(firstType, paths, ancestors);
        }
        return undefined;
    }

    private async parseEnum(text: string, typeName: string): Promise<ScalarType | undefined> {
        const match = /enum\b[^{]*\{([\s\S]*)\}/.exec(text);
        if (!match) { return undefined; }
        const enumValues = new Map<string, string>();
        let next = 0;
        for (const rawItem of match[1].split(',')) {
            const item = rawItem.trim();
            if (!item) { continue; }
            const assign = /^([A-Za-z_]\w*)\s*=\s*(-?(?:0x[0-9a-fA-F]+|\d+))$/.exec(item);
            if (assign) {
                const value = /^-?0x/i.test(assign[2]) ? parseInt(assign[2], 16) : parseInt(assign[2], 10);
                next = value + 1;
                enumValues.set(String(value), assign[1]);
                continue;
            }
            const name = /^([A-Za-z_]\w*)$/.exec(item);
            if (name) {
                enumValues.set(String(next), name[1]);
                next++;
            }
        }
        const typeExpression = gdbTypeName(typeName);
        const sizeText = await this.query.evaluate(`sizeof(${typeExpression})`);
        const size = /^\d+/.exec(sizeText) ? parseInt(sizeText, 10) : 4;
        const signedText = await this.query.evaluate(`((${typeExpression})-1) < 0`);
        return {
            kind: 'enum',
            byteSize: size,
            signed: signedText.trim() !== '0',
            enumValues,
            typeName
        };
    }

    private async buildAggregate(parsed: ParsedAggregate, paths?: string[][]): Promise<AggregateType | undefined> {
        const members: MemberLayout[] = [];
        for (const raw of parsed.members) {
            const selected = paths?.filter((path) => path[0] === raw.name)
                .map((path) => path.slice(1 + (raw.arrayDims?.length || 0)));
            if (selected && selected.length === 0) { continue; }
            if (raw.inline) {
                const nested = await this.buildRawAggregate(raw.inline, '', selected);
                if (!nested) {
                    if (paths !== undefined) { continue; }
                    return undefined;
                }
                members.push(memberFromRaw(raw, nested as TypeLayout));
                continue;
            }
            if (raw.functionPointer) {
                const pointerSize = await this.getPointerSize();
                members.push(memberFromRaw(raw, {
                    kind: 'function-pointer', byteSize: pointerSize, typeName: raw.typeText
                }));
                continue;
            }
            const type = await this.resolveTypeText(raw.typeText, selected);
            if (!type) {
                if (paths !== undefined) { continue; }
                return undefined;
            }
            members.push(memberFromRaw(raw, type));
        }
        return { kind: parsed.kind, byteSize: parsed.byteSize, members, typeName: parsed.typeName };
    }

    private async buildRawAggregate(raw: RawAggregate, typeName: string, paths?: string[][]): Promise<AggregateType | undefined> {
        const parsed: ParsedAggregate = {
            kind: raw.kind, byteSize: raw.byteSize, members: raw.members as any, typeName
        };
        return this.buildAggregate(parsed, paths);
    }
}
