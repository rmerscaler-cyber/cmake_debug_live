import { MI2 } from './mi2/mi2';
import { ScalarType, TypeResolver, isScalar } from './live-memory-types';
import { rangeInsideRegion, writableDataRegions } from './live-memory-plan';

export interface LiveWriteResult {
    value: string;
    appliedValue: string;
    overwritten: boolean;
}

/** Accept values, never commands, assignments or inferior function calls. */
export function validateLiveValue(input: string, type: ScalarType): string {
    const value = input.trim();
    if (type.kind === 'bool' && /^(?:true|false|0|1)$/.test(value)) { return value; }
    if (type.kind === 'enum' && [...(type.enumValues?.values() ?? [])].includes(value)) { return value; }
    if (type.kind === 'float') {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
            || !Number.isFinite(Number(value))
            || (type.byteSize === 4 && !Number.isFinite(Math.fround(Number(value))))) {
            throw new Error('请输入该浮点类型范围内的有限数值');
        }
        return /^[+-]?\d+$/.test(value) ? `${value}.0` : value;
    }
    if (!['signed', 'unsigned', 'enum'].includes(type.kind)
        || !/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(value)) {
        throw new Error('请输入整数、十六进制数、布尔值或该类型的枚举名');
    }
    const negative = value.startsWith('-');
    const number = BigInt(value.replace(/^[+-]/, '')) * (negative ? BigInt(-1) : BigInt(1));
    const bits = BigInt(type.byteSize * 8);
    const signed = type.kind === 'signed' || (type.kind === 'enum' && type.signed);
    const min = signed ? -(BigInt(1) << (bits - BigInt(1))) : BigInt(0);
    const max = (BigInt(1) << (signed ? bits - BigInt(1) : bits)) - BigInt(1);
    if (number < min || number > max) { throw new Error('输入值超出变量类型的范围'); }
    // Canonical decimal avoids GDB treating leading zeroes as octal.
    return number.toString(10);
}

/** Path expressions are supplied by GDB; exclude expressions with side effects. */
export function isLiveStoragePath(path: string): boolean {
    const unquoted = path.replace(/'(?:[^'\\]|\\.)*'/g, 'file');
    return !!unquoted && /^[\w\s$.:*()[\]&>-]+$/.test(unquoted)
        && !/[\w\])]\s*\(/.test(unquoted)
        && !unquoted.replace(/->/g, '').includes('-');
}

/** One explicit runtime assignment. No source edits, persistence or replay. */
export class LiveWatchWriter {
    private nextId = 0;
    constructor(
        private readonly mi: MI2,
        private readonly resolver: TypeResolver,
        private readonly isAlive: () => boolean
    ) { }

    public async write(name: string, input: string): Promise<LiveWriteResult> {
        const attributes = await this.mi.sendCommand(`var-show-attributes ${name}`);
        if ((attributes.result('attr') ?? attributes.result('status')) !== 'editable') { throw new Error('此表达式不可赋值'); }
        const path = await this.mi.varInfoPathExpression(name);
        if (!path || !isLiveStoragePath(path)) { throw new Error('仅支持没有副作用的变量或成员路径'); }
        // /r expands typedefs and preserves const, unlike the sampler's normalized types.
        const declaration = await this.mi.sendCliCommand(`whatis /r (${path})`);
        const rawType = /^type\s*=\s*(.+)$/m.exec(declaration.replace(/\r/g, ''))?.[1];
        if (!rawType || /\bconst\b/.test(rawType)) { throw new Error('只读或无法确认类型的变量不能修改'); }
        const type = await this.mi.varInfoType(name);
        if (!type) { throw new Error('无法取得变量类型'); }
        const layout = await this.resolver.resolveTypeText(type);
        if (!isScalar(layout) || layout.kind === 'pointer' || layout.kind === 'function-pointer') {
            throw new Error('请编辑整数、浮点、布尔或枚举成员，不能整体修改结构体、数组或指针');
        }
        const value = validateLiveValue(input, layout);
        const addressText = await this.mi.evaluateNumber(`&(${path})`);
        const sizeText = await this.mi.evaluateNumber(`sizeof(${path})`);
        const addressMatch = /^0x([0-9a-f]+)(?:\s|$)/i.exec(addressText.trim());
        const address = addressMatch ? parseInt(addressMatch[1], 16) : NaN;
        const size = /^\d+$/.test(sizeText.trim()) ? Number(sizeText) : NaN;
        if (!Number.isSafeInteger(address) || address === 0 || size !== layout.byteSize) {
            throw new Error('变量没有可靠的内存地址或大小，不能实时修改');
        }
        const sections = writableDataRegions(await this.mi.sendCliCommand('maintenance info sections'));
        // Extra sampling regions only authorize reads. Do not let a read setting
        // grant writes into Flash, peripherals, or storage of uncertain lifetime.
        if (!sections.some((region) => rangeInsideRegion({ address, length: size }, region))) {
            throw new Error('变量不在已确认的可写 RAM 中，不能修改 Flash、只读区或外设寄存器');
        }
        if (!this.isAlive()) { throw new Error('调试会话已结束'); }
        // Use a temporary varobj at the freshly resolved, verified address. This
        // avoids assigning via a stale cached pointer child, and GDB handles
        // target type conversion and endianness. Only this field is written.
        const temp = `live_write_${++this.nextId}`;
        await this.mi.varCreate(0, `*(${type} *)0x${address.toString(16)}`, temp, '@');
        try {
            if (!this.isAlive()) { throw new Error('调试会话已结束'); }
            const assigned = await this.mi.varAssign(temp, value, -1, -1);
            const appliedValue = String(assigned.result('value'));
            // Read target memory again; a feedback field may already be overwritten.
            try {
                await this.mi.varUpdate(temp, -1, -1);
                const readback = await this.mi.sendCommand(`var-evaluate-expression ${temp}`);
                const actual = String(readback.result('value'));
                return { value: actual, appliedValue, overwritten: actual !== appliedValue };
            } catch (error) {
                throw new Error(`写入已完成，但回读失败：${String(error)}`);
            }
        } finally {
            await Promise.resolve(this.mi.sendCommand(`var-delete ${temp}`)).catch(() => undefined);
        }
    }
}
