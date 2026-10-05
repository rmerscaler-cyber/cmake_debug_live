const assert = require('assert');
const Module = require('module');
const vscode = {
    TreeItem: class {}, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {}, ThemeColor: class {},
    EventEmitter: class {
        constructor() { this.event = () => ({ dispose() {} }); }
        fire() {}
    },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { LiveVariableNode, LiveWatchTreeProvider } = require('../out/src/frontend/views/live-watch');
const persisted = new Map();
const provider = new LiveWatchTreeProvider({ subscriptions: [], workspaceState: {
    get: (key, fallback) => persisted.get(key) ?? fallback,
    update: (key, value) => persisted.set(key, value)
} });
const requests = [];
let complete;
const session = { id: 's1', customRequest(command, args) {
    requests.push({ command, args });
    return new Promise((resolve) => {
        complete = resolve;
    });
} };
LiveWatchTreeProvider.session = session;
const root = new LiveVariableNode(undefined, '', '');
const struct = new LiveVariableNode(root, 'pid', 'pid', '{...}', 'Pid', 256);
const kp = new LiveVariableNode(struct, 'kp', 'kp', '1.25', 'float');
kp.session = session;
kp.gdbVarName = 'watch.kp';
kp.setTypeInfo('float', 'scalar');
kp.applyFrameValues(new Map([['watch.kp', '1.25']]), new Map(), []);
struct.children = [kp];
root.children = [struct];
provider.variables = root;
let refreshed = 0;
provider.refresh = () => {
    refreshed++;
};
assert(kp.canEditValue());
assert(!struct.canEditValue());
kp.setTypeInfo('const float', 'scalar');
assert(!kp.canEditValue());
kp.rawType = 'float';
struct.rawType = 'const Pid';
assert(!kp.canEditValue(), 'members of readonly parent stay readonly');
struct.rawType = 'Pid';
struct.setPinnedLocal({ address: '0x20000000' });
assert(!kp.canEditValue(), 'pinned stack descendants are not runtime write targets');
struct.pinnedLocal = undefined;
(async () => {
    const write = provider.setViewValue('pid\u001fkp', '3.25', 's1');
    assert.deepStrictEqual(requests, [{ command: 'liveSetValue', args: { name: 'watch.kp', value: '3.25' } }]);
    complete({ value: '3.25', appliedValue: '3.25', overwritten: false });
    await write;
    assert.strictEqual(refreshed, 1);
    assert.strictEqual(kp.getViewRow(1, false).value, '1.25', 'display waits for a real sample');
    provider.saveState();
    const state = [...persisted.values()].find((value) => value && value.children);
    const savedLeaf = state.children[0].children[0];
    assert(!Object.hasOwn(savedLeaf, 'value'), 'assigned values never enter saved watch state');
    assert(!Object.hasOwn(savedLeaf, 'gdbVarName'), 'debug handles are session-only');
    await assert.rejects(provider.setViewValue('pid\u001fkp', '9', 'old-session'));
    assert.strictEqual(requests.length, 1, 'stale-session edit cannot reach backend');
    const pending = provider.setViewValue('pid\u001fkp', '8', 's1');
    LiveWatchTreeProvider.session = { id: 's2' };
    complete({ value: '8', appliedValue: '8', overwritten: false });
    await assert.rejects(pending, /过期/);
    assert.strictEqual(refreshed, 1, 'old write cannot refresh a replacement session');
    assert(!kp.canEditValue());
    console.log('Live Watch frontend: real-sample display, readonly candidates, no persistence and stale sessions passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
