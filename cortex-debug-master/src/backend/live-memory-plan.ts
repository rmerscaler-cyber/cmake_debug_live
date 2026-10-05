/**
 * Pure functions for the live-memory read plan: address regions, range
 * merging (including cross-object merging inside one verified RAM region),
 * chunking and adaptive block sizing.
 */

export interface MemoryRange {
    address: number;
    length: number;
}

export interface AddressRegion {
    start: number;      // inclusive
    end: number;        // exclusive
}

export interface MergeOptions {
    maxBlockBytes: number;
    maxGapBytes: number;
    regions: AddressRegion[];
}

/** Writable data sections describe runtime storage, not the Flash load image. */
export function writableDataRegions(output: string): AddressRegion[] {
    const regions: AddressRegion[] = [];
    const regex = /^\s*\[\d+\]\s+(0x[0-9a-fA-F]+)->(0x[0-9a-fA-F]+)\s+at\s+0x[0-9a-fA-F]+:\s+(\S+)\s*(.*)$/;
    for (const line of output.replace(/\r/g, '').split('\n')) {
        const match = regex.exec(line);
        if (!match) { continue; }
        const flags = match[4] || '';
        if (!/\bALLOC\b/.test(flags) || /\bREADONLY\b/.test(flags) || /\bCODE\b/.test(flags)) { continue; }
        const start = parseInt(match[1], 16);
        const end = parseInt(match[2], 16);
        if (end > start) { regions.push({ start, end }); }
    }
    return normalizeRegions(regions);
}

export function normalizeRegions(regions: AddressRegion[]): AddressRegion[] {
    const sorted = regions
        .filter((region) => region.end > region.start)
        .slice()
        .sort((a, b) => a.start - b.start);
    const merged: AddressRegion[] = [];
    for (const region of sorted) {
        const last = merged[merged.length - 1];
        if (last && region.start <= last.end) {
            last.end = Math.max(last.end, region.end);
        } else {
            merged.push({ start: region.start, end: region.end });
        }
    }
    return merged;
}

export function regionContaining(regions: AddressRegion[], address: number): AddressRegion | undefined {
    for (const region of regions) {
        if (address >= region.start && address < region.end) { return region; }
    }
    return undefined;
}

export function rangeInsideRegion(range: MemoryRange, region: AddressRegion): boolean {
    return range.address >= region.start && (range.address + range.length) <= region.end;
}

/**
 * Merges overlapping/adjacent ranges and ranges whose gap is <= maxGapBytes,
 * but never merges across regions and never exceeds maxBlockBytes. Ranges that
 * are not fully inside a whitelisted region are returned in `rejected` so the
 * caller can route them to the compatibility path (they are never read).
 */
export function mergeRanges(
    ranges: MemoryRange[],
    options: MergeOptions
): { blocks: MemoryRange[]; rejected: MemoryRange[] } {
    const valid: MemoryRange[] = [];
    const rejected: MemoryRange[] = [];
    for (const range of ranges) {
        if (range.length <= 0) { continue; }
        const region = regionContaining(options.regions, range.address);
        if (region && rangeInsideRegion(range, region)) {
            valid.push({ address: range.address, length: range.length });
        } else {
            rejected.push({ address: range.address, length: range.length });
        }
    }
    valid.sort((a, b) => a.address - b.address);

    const merged: MemoryRange[] = [];
    for (const range of valid) {
        const last = merged[merged.length - 1];
        if (!last) {
            merged.push({ ...range });
            continue;
        }
        const lastRegion = regionContaining(options.regions, last.address);
        const rangeRegion = regionContaining(options.regions, range.address);
        const sameRegion = !!lastRegion && !!rangeRegion
            && lastRegion.start === rangeRegion.start && lastRegion.end === rangeRegion.end;
        const lastEnd = last.address + last.length;
        const gap = range.address - lastEnd;
        const unionEnd = Math.max(lastEnd, range.address + range.length);
        const unionLength = unionEnd - last.address;
        if (sameRegion && gap <= options.maxGapBytes && unionLength <= options.maxBlockBytes) {
            last.length = unionLength;
        } else {
            merged.push({ ...range });
        }
    }

    // Split anything larger than the block limit.
    const result: MemoryRange[] = [];
    for (const range of merged) {
        let address = range.address;
        let remaining = range.length;
        while (remaining > options.maxBlockBytes) {
            result.push({ address, length: options.maxBlockBytes });
            address += options.maxBlockBytes;
            remaining -= options.maxBlockBytes;
        }
        result.push({ address, length: remaining });
    }
    return { blocks: result, rejected };
}

/**
 * Grow the block size only after the current size is being filled. High command
 * latency is expected on remote probes and is not a reason to create more
 * round trips. Failed blocks are handled by the reader and must be split there.
 */
export function nextBlockSize(
    current: number,
    bytesPerCommand: number,
    maxBytes: number
): number {
    if (!Number.isFinite(bytesPerCommand) || bytesPerCommand <= 0) { return current; }
    if (bytesPerCommand >= current * 0.9 && current < maxBytes) {
        return Math.min(maxBytes, current * 2);
    }
    return current;
}

export function totalBytes(ranges: MemoryRange[]): number {
    let total = 0;
    for (const range of ranges) {
        total += range.length;
    }
    return total;
}
