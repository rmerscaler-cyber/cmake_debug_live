import * as vscode from 'vscode';

export type SearchScope = 'file' | 'project' | 'workspace';
export type SearchKind = 'text' | 'definition' | 'references';
export const scopeLabels: Record<SearchScope, string> = { file: '当前文件', project: '当前工程', workspace: '整个工作区' };

/** Escape literal paths rather than interpreting project/file names as globs. */
export function searchPathLiteral(value: string): string {
    return value.replace(/[[\]{}*?,]/g, (character) => `[${character}]`);
}

export function sameResource(left: vscode.Uri, right: vscode.Uri): boolean {
    return left.scheme === right.scheme && left.authority === right.authority && resourcePath(left) === resourcePath(right);
}

function resourcePath(uri: vscode.Uri): string {
    return uri.scheme === 'file' && process.platform === 'win32' ? uri.path.toLowerCase() : uri.path;
}

export function inDirectory(directory: vscode.Uri, uri: vscode.Uri): boolean {
    if (directory.scheme !== uri.scheme || directory.authority !== uri.authority) { return false; }
    const root = resourcePath(directory).replace(/\/$/, '');
    const filename = resourcePath(uri);
    return filename === root || filename.startsWith(root + '/');
}

export function scopeContains(scope: SearchScope, uri: vscode.Uri, file: vscode.Uri, project: vscode.Uri): boolean {
    if (scope === 'file') { return !!file && sameResource(file, uri); }
    if (scope === 'project') { return !!project && inDirectory(project, uri); }
    return !!vscode.workspace.getWorkspaceFolder(uri);
}

export function nativeSearchInclude(uri: vscode.Uri, directory: boolean): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    let filename = uri.fsPath.replace(/\\/g, '/');
    if (folder) {
        const relative = uri.path.slice(folder.uri.path.replace(/\/$/, '').length).replace(/^\//, '');
        filename = './' + ((vscode.workspace.workspaceFolders?.length || 0) > 1 ? folder.name + '/' : '') + relative;
    }
    return searchPathLiteral(filename.replace(/\/$/, '')) + (directory ? '/**' : '');
}

export function nativeSearchOptions(query: string, scope: SearchScope, file: vscode.Uri, project: vscode.Uri) {
    return {
        query, filesToInclude: scope === 'workspace' ? '' : nativeSearchInclude(scope === 'file' ? file : project, scope === 'project'),
        // Reset sticky filters that can make a supposedly global search cover only one file or hide ignored source folders.
        filesToExclude: '**/.git/**, **/node_modules/**', onlyOpenEditors: false, useExcludeSettingsAndIgnoreFiles: false,
        isRegex: false, isCaseSensitive: true, matchWholeWord: true, triggerSearch: true, showIncludesExcludes: true
    };
}

export function normalizeLocations(values: Array<vscode.Location | vscode.LocationLink>): vscode.Location[] {
    const unique = new Map<string, vscode.Location>();
    for (const value of values || []) {
        const location = 'targetUri' in value ? new vscode.Location(value.targetUri, value.targetSelectionRange || value.targetRange) : value;
        const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`;
        if (!unique.has(key)) { unique.set(key, location); }
    }
    return [...unique.values()].sort((a, b) => a.uri.toString().localeCompare(b.uri.toString())
        || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}
