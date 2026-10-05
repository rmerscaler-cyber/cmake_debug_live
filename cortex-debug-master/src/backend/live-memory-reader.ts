/**
 * MemoryReader abstraction for the live-memory sampler and its GDB/MI
 * implementation. Response parsing is strict: holes, overlaps, short data or
 * invalid hex cause an error instead of silent zeroes.
 */
import { MemoryRange } from './live-memory-plan';

export interface MemoryFragment {
    begin: number;
    end: number;
    offset: number;
    contents: string;
}

export interface MemoryReadResult {
    range: MemoryRange;
    data?: Buffer;
    error?: string;
    elapsedMs: number;
    fragments: number;
}

export interface MemoryReader {
    readRanges(ranges: MemoryRange[]): Promise<MemoryReadResult[]>;
}

export interface MemoryTransport {
    readMemoryRange(address: number, length: number): Promise<{ address: number; data: Buffer; fragments: number }>;
}

/**
 * Extracts fragments from a GDB/MI `-data-read-memory-bytes` `memory` result.
 * The MI parser yields an array of tuples, each an array of [key, value].
 */
export function fragmentsFromMi(memory: any): MemoryFragment[] | undefined {
    if (!Array.isArray(memory) || memory.length === 0) { return undefined; }
    const fragments: MemoryFragment[] = [];
    for (const tuple of memory) {
        if (!Array.isArray(tuple)) { return undefined; }
        const fields = new Map<string, string>();
        for (const pair of tuple) {
            if (Array.isArray(pair) && pair.length === 2) {
                fields.set(String(pair[0]), String(pair[1]));
            }
        }
        const begin = fields.get('begin');
        const end = fields.get('end');
        const offset = fields.get('offset');
        const contents = fields.get('contents');
        if (begin === undefined || end === undefined || offset === undefined || contents === undefined) {
            return undefined;
        }
        const beginValue = parseInt(begin, 16);
        const endValue = parseInt(end, 16);
        const offsetValue = parseInt(offset, 16);
        if (!Number.isFinite(beginValue) || !Number.isFinite(endValue) || !Number.isFinite(offsetValue)) {
            return undefined;
        }
        if (contents !== '' && !/^[0-9a-fA-F]+$/.test(contents)) { return undefined; }
        fragments.push({ begin: beginValue, end: endValue, offset: offsetValue, contents });
    }
    return fragments;
}

/**
 * Validates that the fragments cover exactly `[address, address+length)` with
 * no holes and no overlapping conflicts, then returns the assembled buffer.
 */
export function assembleFragments(fragments: MemoryFragment[], address: number, length: number): { data: Buffer; fragments: number } {
    if (length <= 0) { throw new Error('empty memory request'); }
    const ordered = fragments.slice().sort((a, b) => (a.begin + a.offset) - (b.begin + b.offset));
    let expected = address;
    const parts: Buffer[] = [];
    for (const fragment of ordered) {
        const start = fragment.begin + fragment.offset;
        const size = fragment.end - fragment.begin;
        if (size < 0) { throw new Error('invalid memory fragment bounds'); }
        const data = Buffer.from(fragment.contents, 'hex');
        if (data.length !== size) { throw new Error('memory fragment length mismatch'); }
        if (start > expected) { throw new Error('memory response has a hole'); }
        if (start < expected) {
            const overlap = expected - start;
            if (overlap >= data.length) { continue; }
            parts.push(data.slice(overlap));
            expected += data.length - overlap;
            continue;
        }
        parts.push(data);
        expected += data.length;
    }
    const data = Buffer.concat(parts);
    if (expected !== address + length || data.length !== length) {
        throw new Error('memory response does not cover the requested range');
    }
    return { data, fragments: ordered.length };
}

export class GdbMemoryReader implements MemoryReader {
    constructor(private readonly transport: MemoryTransport) { }

    public async readRanges(ranges: MemoryRange[]): Promise<MemoryReadResult[]> {
        const results: MemoryReadResult[] = [];
        for (const range of ranges) {
            const started = Date.now();
            try {
                const response = await this.transport.readMemoryRange(range.address, range.length);
                results.push({
                    range,
                    data: response.data,
                    elapsedMs: Date.now() - started,
                    fragments: response.fragments
                });
            } catch (error) {
                results.push({
                    range,
                    error: error instanceof Error ? error.message : String(error),
                    elapsedMs: Date.now() - started,
                    fragments: 0
                });
            }
        }
        return results;
    }
}
