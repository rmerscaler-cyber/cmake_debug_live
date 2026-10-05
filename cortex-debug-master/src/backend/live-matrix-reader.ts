import { LiveMatrixRequest, LiveMatrixSample, LiveMatrixShape, validMatrixShape } from '../live-matrix';
import { decodeScalarValue, TargetEndianness } from './live-memory-decode';
import { ScalarType, TypeResolver, isScalar } from './live-memory-types';

interface MatrixTransport {
    varInfoPathExpression(name: string): Promise<string>;
    evaluateNumber(expression: string): Promise<string>;
    sendCliCommand(command: string): Promise<string>;
    readMemoryRange(address: number, length: number): Promise<{ data: Buffer }>;
}

interface MatrixStorage {
    addressExpression: string;
    scalar: ScalarType;
    length: number;
}

function numberFromGdb(value: string): number {
    const match = /^(0x[\da-f]+|\d+)(?:\s|$)/i.exec(value.trim());
    return match ? Number(match[1]) : NaN;
}

/** Matrix storage is resolved independently of its parent's C++ class layout. */
export class LiveMatrixReader {
    private readonly storage = new Map<string, Promise<MatrixStorage>>();
    private endianness: TargetEndianness | undefined;

    constructor(
        private readonly transport: MatrixTransport,
        private readonly resolver: TypeResolver,
        private readonly storagePath?: (name: string) => string | undefined
    ) { }

    public clear(): void {
        this.storage.clear();
        this.endianness = undefined;
    }

    private async prepare(name: string, shape: LiveMatrixShape): Promise<MatrixStorage> {
        const path = this.storagePath?.(name) || await this.transport.varInfoPathExpression(name);
        if (!path) { throw new Error('矩阵表达式已失效'); }
        // Only address/sizeof expressions are evaluated; no Eigen accessor methods.
        const array = shape.kind === 'eigen' ? `(${path}).m_storage.m_data.array` : `(${path})`;
        const arrayType = shape.kind === 'array' ? await this.transport.sendCliCommand(`whatis ${array}`) : '';
        const twoDimensional = /\[\s*\d+\s*\]\s*\[\s*\d+\s*\]/.test(arrayType);
        const element = `${array}[0]${twoDimensional ? '[0]' : ''}`;
        const elementSize = numberFromGdb(await this.transport.evaluateNumber(`sizeof(${element})`));
        const length = numberFromGdb(await this.transport.evaluateNumber(`sizeof(${array})`));
        const scalar = await this.resolver.resolveTypeText(shape.scalar);
        if (!isScalar(scalar) || !['float', 'signed', 'unsigned', 'bool'].includes(scalar.kind)
            || ![1, 2, 4, 8].includes(elementSize)
            || length !== elementSize * shape.rows * shape.columns) {
            throw new Error('无法确认矩阵元素类型或连续存储大小');
        }
        return { addressExpression: `&(${element})`, scalar: { ...scalar, byteSize: elementSize }, length };
    }

    public async sample(request: LiveMatrixRequest, shape: LiveMatrixShape): Promise<LiveMatrixSample> {
        try {
            if (!validMatrixShape(request.rows, request.columns)
                || request.rows * request.columns !== shape.rows * shape.columns
                || (shape.kind === 'eigen' && (request.rows !== shape.rows || request.columns !== shape.columns))) {
                throw new Error('矩阵行列数与存储大小不一致');
            }
            let prepared = this.storage.get(request.id);
            if (!prepared) {
                prepared = this.prepare(request.id, shape).catch((error) => {
                    this.storage.delete(request.id);
                    throw error;
                });
                this.storage.set(request.id, prepared);
            }
            const storage = await prepared;
            if (!this.endianness) {
                const endian = await this.transport.sendCliCommand('show endian');
                if (!/little endian|big endian/i.test(endian)) { throw new Error('无法确认目标字节序'); }
                this.endianness = /big endian/i.test(endian) ? 'big' : 'little';
            }
            // Resolve each frame so a matrix reached through a moving pointer stays current.
            const address = numberFromGdb(await this.transport.evaluateNumber(storage.addressExpression));
            if (!Number.isSafeInteger(address) || address <= 0) { throw new Error('矩阵没有有效内存地址'); }
            const parts: Buffer[] = [];
            for (let offset = 0; offset < storage.length; offset += 2048) {
                const length = Math.min(2048, storage.length - offset);
                const read = await this.transport.readMemoryRange(address + offset, length);
                if (read.data.length !== length) { throw new Error('矩阵内存读取不完整'); }
                parts.push(read.data);
            }
            const bytes = Buffer.concat(parts);
            const values: string[] = [];
            for (let row = 0; row < request.rows; row++) {
                for (let column = 0; column < request.columns; column++) {
                    const index = shape.rowMajor ? row * request.columns + column : column * request.rows + row;
                    const value = decodeScalarValue(bytes, index * storage.scalar.byteSize, storage.scalar, this.endianness);
                    if (value === undefined) { throw new Error('矩阵元素解码失败'); }
                    values.push(value);
                }
            }
            return { name: request.id, values };
        } catch (error) {
            return { name: request.id, values: [], error: String(error) };
        }
    }
}
