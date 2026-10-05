export type LiveDisplayMode = 'auto' | 'tree' | 'matrix';

export interface LiveMatrixShape {
    rows: number;
    columns: number;
    scalar: string;
    rowMajor: boolean;
    kind: 'eigen' | 'array';
    automatic: boolean;
}

export interface LiveMatrixRequest {
    id: string;
    rows: number;
    columns: number;
}

export interface LiveMatrixSample {
    name: string;
    values: string[];
    error?: string;
}

export const MAX_MATRIX_CELLS = 4096;

/** Split template arguments without splitting nested template types. */
function templateArguments(text: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '<') { depth++; }
        if (text[i] === '>') { depth--; }
        if (text[i] === ',' && depth === 0) {
            result.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    result.push(text.slice(start).trim());
    return result;
}

export function validMatrixShape(rows: number, columns: number): boolean {
    return Number.isSafeInteger(rows) && Number.isSafeInteger(columns)
        && rows > 0 && columns > 0 && rows * columns <= MAX_MATRIX_CELLS;
}

/** Fixed Eigen matrices/vectors and numeric C arrays. One-dimensional arrays opt in. */
export function parseMatrixShape(type: string): LiveMatrixShape | undefined {
    const text = type.trim().replace(/^(?:struct|class)\s+/, '');
    const eigen = /^Eigen::(?:Matrix|Array)<(.+)>$/.exec(text);
    if (eigen) {
        const args = templateArguments(eigen[1]);
        if (args.length < 3 || !/^\d+$/.test(args[1]) || !/^\d+$/.test(args[2])) { return undefined; }
        const rows = Number(args[1]);
        const columns = Number(args[2]);
        const options = args[3] === undefined ? 0 : Number(args[3]);
        if (!validMatrixShape(rows, columns) || !Number.isSafeInteger(options)) { return undefined; }
        return { rows, columns, scalar: args[0], rowMajor: (options & 1) !== 0, kind: 'eigen', automatic: true };
    }
    const array = /^(.*?)\s*((?:\[\s*\d+\s*\]){1,2})$/.exec(text);
    if (!array) { return undefined; }
    const scalar = array[1].replace(/\b(?:const|volatile)\b/g, '').trim();
    if (!/^(?:(?:unsigned|signed)\s+)?(?:char|short(?: int)?|int|long(?: long)?(?: int)?|float|double|bool|_Bool|u?int(?:8|16|32|64)_t)$/.test(scalar)) {
        return undefined;
    }
    const dims = [...array[2].matchAll(/\[\s*(\d+)\s*\]/g)].map((match) => Number(match[1]));
    const rows = dims.length === 2 ? dims[0] : 1;
    const columns = dims.length === 2 ? dims[1] : dims[0];
    return validMatrixShape(rows, columns)
        ? { rows, columns, scalar, rowMajor: true, kind: 'array', automatic: dims.length === 2 }
        : undefined;
}
