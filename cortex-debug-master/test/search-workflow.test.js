const assert = require('assert');
const path = require('path');
const Module = require('module');

class Uri {
    constructor(filename, scheme = 'file', authority = '') {
        this.path = filename;
        this.fsPath = filename;
        this.scheme = scheme;
        this.authority = authority;
    }

    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
    static file(filename) { return new Uri(filename); }
    static joinPath(uri, ...parts) { return new Uri(path.posix.join(uri.path, ...parts), uri.scheme, uri.authority); }
}
class Range {
    constructor(line, column, endLine = line, endColumn = column + 6) {
        this.start = { line, character: column };
        this.end = { line: endLine, character: endColumn };
    }
}
class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
    }
}
const root = { name: 'alpha', uri: Uri.file('/work/alpha') };
const other = { name: 'beta', uri: Uri.file('/work/beta') };
const main = Uri.file('/work/alpha/firmware/src/main.c');
const definitions = Uri.file('/work/alpha/firmware/defs.c');
const outside = Uri.file('/work/beta/other.c');
let folders = [root];
let projectDirectory = 'firmware';
let mode = 'reuseEditor';
let queryAnswer;
let picks = [];
let provider = [];
let cancellation;
let activeListener;
const calls = [];
const opened = [];
const messages = [];
const updates = [];
const registered = new Map();
const knownFiles = new Set(['/work/alpha/firmware/CMakeLists.txt']);
const token = { isCancellationRequested: false, onCancellationRequested: (fn) => {
    cancellation = () => {
        token.isCancellationRequested = true;
        fn();
    };
    return { dispose() {} };
} };
const document = (uri, word = 'shared') => ({
    uri, isClosed: false, isUntitled: false, lineCount: 10,
    getWordRangeAtPosition: () => new Range(2, 0), getText: () => word,
    lineAt: (line) => ({ text: `line ${line}: ${word}` })
});
const editor = (uri, word) => ({ document: document(uri, word), selection: { start: { line: 2, character: 0 }, isEmpty: true } });
const vscode = {
    Uri, Range, Location, TreeItem: class {
        constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    },
    ThemeIcon: class {}, EventEmitter: class { fire() {} dispose() {} },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 }, ProgressLocation: { Notification: 15 }, ConfigurationTarget: { Workspace: 2 },
    commands: {
        registerCommand: (id, callback) => {
            registered.set(id, callback);
            return { dispose() {} };
        },
        executeCommand: async (id, ...args) => {
            calls.push([id, ...args]);
            if (/vscode.execute(?:Definition|Reference)Provider/.test(id)) { return typeof provider === 'function' ? provider(...args) : provider; }
        }
    },
    workspace: {
        get workspaceFolders() { return folders; },
        getWorkspaceFolder: (uri) => folders.find((folder) => uri.scheme === folder.uri.scheme
            && (uri.path === folder.uri.path || uri.path.startsWith(folder.uri.path + '/'))),
        asRelativePath: (uri) => uri.path,
        getConfiguration: (section) => ({
            get: (key, fallback) => section === 'search' && key === 'mode'
                ? mode
                : section === 'rm-debug' && key === 'projectDirectory' ? projectDirectory : fallback,
            update: async (key, value, target) => {
                updates.push([key, value, target]);
                mode = value;
            }
        }),
        openTextDocument: async (uri) => document(uri),
        fs: {
            stat: async (uri) => {
                if (!knownFiles.has(uri.path)) { throw new Error('not found'); }
                return {};
            },
            readFile: async () => { throw new Error('not found'); }
        }
    },
    extensions: { getExtension: () => undefined },
    window: {
        activeTextEditor: editor(main),
        createTreeView: () => ({ reveal: async () => {}, dispose() {} }),
        createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
        onDidChangeActiveTextEditor: (fn) => {
            activeListener = fn;
            return { dispose() {} };
        },
        showQuickPick: async (items) => {
            const pick = picks.shift();
            return pick === undefined ? undefined : items.find((item) => item.value === pick);
        },
        showInputBox: async () => queryAnswer,
        showTextDocument: async (uri, options) => opened.push([uri, options]),
        showWarningMessage: async (message) => { messages.push(message); },
        showErrorMessage: async (message) => { messages.push(message); },
        showInformationMessage: async (message) => { messages.push(message); },
        withProgress: async (_options, callback) => {
            token.isCancellationRequested = false;
            return callback({}, token);
        }
    }
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
};
const scope = require('../out/src/frontend/search-scope');
const { RmSearch } = require('../out/src/frontend/rm-search');
const search = new RmSearch({ subscriptions: [] });

(async () => {
    assert.strictEqual(scope.nativeSearchInclude(main, false), './firmware/src/main.c');
    assert.strictEqual(scope.nativeSearchInclude(root.uri, true), './**');
    assert(!scope.inDirectory(root.uri, Uri.file('/work/alphabet/file.c')), 'directory prefix must respect path segments');
    assert(!scope.inDirectory(root.uri, new Uri('/work/alpha/file.c', 'vscode-remote', 'ssh-remote+host')));
    assert.strictEqual(scope.searchPathLiteral('a[1],{x}*.c'), 'a[[]1[]][,][{]x[}][*].c');
    folders = [root, other];
    assert.strictEqual(scope.nativeSearchInclude(main, false), './alpha/firmware/src/main.c');
    assert.strictEqual(scope.nativeSearchInclude(Uri.file('/work/beta'), true), './beta/**');

    queryAnswer = 'shared';
    await search.search('text', 'workspace');
    const full = calls.find((call) => call[0] === 'workbench.action.findInFiles')[1];
    assert.strictEqual(full.filesToInclude, '');
    assert.strictEqual(full.onlyOpenEditors, false);
    assert.strictEqual(full.useExcludeSettingsAndIgnoreFiles, false);
    assert.strictEqual(full.filesToExclude, '**/.git/**, **/node_modules/**');
    assert.strictEqual(full.isRegex, false);
    assert.strictEqual(full.matchWholeWord, true);
    assert.deepStrictEqual(updates, [['mode', 'view', 2]], 'search must go to the requested sidebar even if Search Editor was previously selected');
    calls.length = 0;
    await search.search('text', 'file');
    assert.strictEqual(calls[0][1].filesToInclude, './alpha/firmware/src/main.c');
    calls.length = 0;
    await search.search('text', 'project');
    assert.strictEqual(calls[0][1].filesToInclude, './alpha/firmware/**');
    projectDirectory = '';
    assert.strictEqual((await search.project(root, search.source())).path, '/work/alpha/firmware',
        'unconfigured nested projects must be detected from the source');
    projectDirectory = 'firmware';

    // Capture the active source before pickers take focus, and continue using it from sidebar commands.
    activeListener(vscode.window.activeTextEditor);
    vscode.window.activeTextEditor = undefined;
    calls.length = 0;
    picks = ['text', 'file'];
    await registered.get('rm-debug.search')();
    assert.strictEqual(calls[0][1].filesToInclude, './alpha/firmware/src/main.c');
    calls.length = 0;
    picks = [];
    await search.search();
    assert.strictEqual(calls.length, 0, 'cancelled picker must not change search filters');

    const local = new Location(main, new Range(2, 0));
    const definition = { targetUri: definitions, targetRange: new Range(0, 0), targetSelectionRange: new Range(1, 4) };
    const foreign = new Location(outside, new Range(3, 7));
    provider = [local, definition, local, foreign];
    calls.length = 0;
    await search.search('definition', 'project');
    const providerCall = calls.find((call) => call[0] === 'vscode.executeDefinitionProvider');
    assert.strictEqual(providerCall[1], main);
    assert.deepStrictEqual(providerCall[2], { line: 2, character: 0 });
    let files = search.results.getChildren();
    assert.strictEqual(files.length, 2, 'project scope must exclude the other workspace root and deduplicate results');
    const leaf = files.find((file) => file.uri.path === definitions.path).children[0];
    assert.deepStrictEqual(leaf.location.range, definition.targetSelectionRange, 'jump to the symbol rather than the surrounding declaration');
    await registered.get('rm-debug.search.openResult')(leaf.location);
    assert.strictEqual(opened[0][0], definitions);
    assert.deepStrictEqual(opened[0][1].selection, definition.targetSelectionRange);
    assert(search.view.message.includes('范围内 2 处；语言服务返回 3 处'));

    calls.length = 0;
    await search.search('references', 'file');
    assert(calls.some((call) => call[0] === 'vscode.executeReferenceProvider'));
    assert(!calls.some((call) => call[0] === 'workbench.action.findInFiles'), 'text matches must not be substituted for semantic references');
    assert.strictEqual(search.results.getChildren().length, 1);
    await search.search('references', 'workspace');
    assert.strictEqual(search.results.getChildren().length, 3, 'workspace scope must include matches across roots');

    provider = [];
    await search.search('definition', 'workspace');
    assert(search.view.message.includes('未取得符号结果'));
    assert(messages.some((message) => message.includes('工程索引')));
    provider = () => new Promise(() => {});
    const pending = search.search('references', 'workspace');
    cancellation();
    await pending;
    assert.strictEqual(search.results.getChildren().length, 0, 'cancelled requests must preserve previous results');

    let finishOld;
    provider = () => new Promise((resolve) => {
        finishOld = resolve;
    });
    const oldRequest = search.search('references', 'workspace');
    provider = [local];
    await search.search('references', 'workspace');
    finishOld([foreign]);
    await oldRequest;
    files = search.results.getChildren();
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].uri, main, 'late responses must not overwrite the most recent search');
    await registered.get('rm-debug.search.clearResults')();
    assert.strictEqual(search.results.getChildren().length, 0);
    console.log('Search: sidebar integration, nested/multi-root scope, filter reset, focus capture, symbol ranges, cancellation and stale replies passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => { Module._load = originalLoad; });
