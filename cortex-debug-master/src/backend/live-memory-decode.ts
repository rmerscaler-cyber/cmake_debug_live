/**
 * Buffer to display-value decoding for the live-memory sampler.
 * Values are formatted close to GDB's output so the tree and plots behave the
 * same, but the numeric content is what matters for correctness.
 */
import { ScalarType } from './live-memory-types';

export type TargetEndianness = 'little' | 'big';

function formatG(value: number, precision: number): string {
    if (Number.isNaN(value)) { return 'nan'; }
    if (!Number.isFinite(value)) { return value > 0 ? 'inf' : '-inf'; }
    if (value === 0) { return Object.is(value, -0) ? '-0' : '0'; }
    let text = value.toPrecision(precision);
    if (/e/i.test(text)) {
        const [mantissa, exponent] = text.split(/e/i);
        let trimmed = mantissa;
        if (trimmed.includes('.')) {
            trimmed = trimmed.replace(/0+$/, '').replace(/\.$/, '');
        }
        const expValue = parseInt(exponent, 10);
        return `${trimmed}e${expValue >= 0 ? '+' : ''}${expValue}`;
    }
    if (text.includes('.')) {
        text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text;
}

export function formatFloat32(value: number): string {
    return formatG(value, 9);
}

export function formatFloat64(value: number): string {
    return formatG(value, 17);
}

function readUnsigned(buffer: Buffer, offset: number, size: number, endianness: TargetEndianness): bigint {
    let result = BigInt(0);
    if (endianness === 'little') {
        for (let i = size - 1; i >= 0; i--) {
            result = (result << BigInt(8)) | BigInt(buffer[offset + i]);
        }
    } else {
        for (let i = 0; i < size; i++) {
            result = (result << BigInt(8)) | BigInt(buffer[offset + i]);
        }
    }
    return result;
}

export function formatPointer(value: bigint, byteSize: number): string {
    return `0x${value.toString(16).padStart(byteSize * 2, '0')}`;
}

/**
 * Decodes a scalar field from a memory block. Returns undefined when the type
 * is unsupported or the block does not cover the field.
 */
export function decodeScalarValue(
    buffer: Buffer,
    offset: number,
    type: ScalarType,
    endianness: TargetEndianness
): string | undefined {
    const size = type.byteSize;
    if (offset < 0 || size <= 0 || offset + size > buffer.length) { return undefined; }
    if (size !== 1 && size !== 2 && size !== 4 && size !== 8) { return undefined; }

    switch (type.kind) {
        case 'float': {
            if (size === 4) {
                const value = endianness === 'little' ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset);
                return formatFloat32(value);
            }
            if (size === 8) {
                const value = endianness === 'little' ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset);
                return formatFloat64(value);
            }
            return undefined;
        }
        case 'bool': {
            const value = readUnsigned(buffer, offset, size, endianness);
            return value !== BigInt(0) ? 'true' : 'false';
        }
        case 'pointer':
        case 'function-pointer': {
            const value = readUnsigned(buffer, offset, size, endianness);
            return formatPointer(value, size);
        }
        case 'enum': {
            const raw = readUnsigned(buffer, offset, size, endianness);
            const signed = type.signed !== false && raw >= (BigInt(1) << BigInt(size * 8 - 1))
                ? BigInt.asIntN(size * 8, raw)
                : raw;
            const name = type.enumValues?.get(signed.toString());
            return name !== undefined ? name : signed.toString();
        }
        case 'signed':
        case 'unsigned': {
            const raw = readUnsigned(buffer, offset, size, endianness);
            if (type.kind === 'signed') {
                const signed = BigInt.asIntN(size * 8, raw);
                return signed.toString();
            }
            return raw.toString();
        }
        default:
            return undefined;
    }
}

/** Reads a pointer-sized unsigned integer (used for pointer dependencies). */
export function decodePointerValue(
    buffer: Buffer,
    offset: number,
    byteSize: number,
    endianness: TargetEndianness
): number | undefined {
    if (offset < 0 || byteSize <= 0 || offset + byteSize > buffer.length) { return undefined; }
    const value = readUnsigned(buffer, offset, byteSize, endianness);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) { return undefined; }
    return Number(value);
}

/** Locates the memory block covering `address`; blocks are prefix-merged. */
export interface DecodeBlock {
    address: number;
    data: Buffer;
}

export function findBlock(blocks: DecodeBlock[], address: number, length: number): DecodeBlock | undefined {
    for (const block of blocks) {
        if (address >= block.address && address + length <= block.address + block.data.length) {
            return block;
        }
    }
    return undefined;
}
