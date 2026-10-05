const assert = require('assert');
const Module = require('module');
const vscode = {
    TreeItem: class {}, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
        constructor() {
            this.listeners = [];
            this.event = (listener) => {
                this.listeners.push(listener);
                return { dispose() {} };
            };
        }

        fire(value) { this.listeners.forEach((listener) => listener(value)); }
    },
    workspace: {
        getConfiguration: () => ({ get: (_name, fallback) => fallback }),
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { LiveVariableNode, LiveWatchTreeProvider } = require('../out/src/frontend/views/live-watch.js');
Module._load = originalLoad;
const context = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
const provider = new LiveWatchTreeProvider(context);
function node(parent, name, type = 'float', reference = 0) {
    const value = new LiveVariableNode(parent, name, name, '0', type, reference);
    value.gdbVarName = name;
    value.setTypeInfo(type, reference ? 'struct' : 'scalar');
    parent.children = [...(parent.children || []), value];
    return value;
}
const root = node(provider.variables, 'state', 'State', 1);
const axis = node(root, 'axis', 'Axis', 2);
const angle = node(axis, 'angle');
node(axis, 'unrelated');
const matrix = node(root, 'matrix', 'float [4]', 3);
matrix.setMatrixInfo({ rows: 2, columns: 2, kind: 'array', rowMajor: true, automatic: false });
matrix.expanded = true;
const path = angle.getPlotPath();
root.expanded = axis.expanded = true;
provider.incrementalReady = true;
const originalSubscription = provider.collectSubscription();
const revision = LiveWatchTreeProvider.subscriptionRevision;
provider.setPlotPaths(new Set([path]));
assert.deepStrictEqual(provider.collectSubscription(), originalSubscription);
assert.strictEqual(LiveWatchTreeProvider.subscriptionRevision, revision,
    'plotting an already sampled value must keep the bulk plan');
assert.strictEqual(provider.incrementalReady, true,
    'plotting must not restart GDB field discovery');
provider.setPlotPaths(new Set([path]));
assert.strictEqual(LiveWatchTreeProvider.subscriptionRevision, revision,
    'duplicate plot selections must not invalidate sampling');

root.expanded = axis.expanded = false;
assert.deepStrictEqual(provider.collectSubscription().map((item) => item.id), ['state', 'axis', 'angle'],
    'a collapsed plot path must not subscribe siblings');
assert.deepStrictEqual(provider.collectMatrixRequests(), [],
    'plotting angle must not enable an unrelated matrix read');
const collapsedRevision = LiveWatchTreeProvider.subscriptionRevision;
provider.setPlotPaths(new Set());
assert.deepStrictEqual(provider.collectSubscription().map((item) => item.id), ['state']);
assert.strictEqual(LiveWatchTreeProvider.subscriptionRevision, collapsedRevision + 1,
    'removing the last collapsed plot path must unsubscribe its fields');
provider.setPlotPaths(new Set([path]));
assert.deepStrictEqual(provider.collectSubscription().map((item) => item.id), ['state', 'axis', 'angle']);
root.setMonitorAll(true);
assert.ok(provider.collectSubscription().some((item) => item.id === 'unrelated'),
    'monitor-all must still subscribe siblings');
assert.strictEqual(provider.collectMatrixRequests().length, 1,
    'monitor-all must still sample matrices');
root.setMonitorAll(false);
root.expanded = axis.expanded = true;

(async () => {
    const requests = [];
    const session = {
        id: 'plot-steady-sampling', configuration: {},
        customRequest(command, args) {
            requests.push({ command, args });
            assert.strictEqual(command, 'liveCacheRefresh', 'adding a plot must not re-evaluate roots');
            return Promise.resolve({ mode: 'bulk', changes: [{ name: 'angle', value: '1.25' }],
                unavailable: [], rebuild: false, readMs: 1,
                frame: { stats: { successfulFieldCount: 1, blockCount: 1, receivedBytes: 4 } } });
        }
    };
    LiveWatchTreeProvider.session = session;
    provider.isStopped = false;
    provider.incrementalReady = true;
    provider.lastSentRevision = LiveWatchTreeProvider.subscriptionRevision;
    provider.startTimer = () => {};
    const samples = [];
    provider.onDidCompleteSample((sample) => samples.push(sample));
    provider.setPlotPaths(new Set());
    provider.setPlotPaths(new Set([path]));
    provider.refresh(session, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].args.subscription, undefined,
        'adding an existing channel must send only the normal memory refresh');
    assert.strictEqual(samples[0].values[path], 1.25, 'plot receives the same fresh value as Live Watch');
    // Recreated nodes after discovery must replace any cached plot node.
    const replacement = new LiveVariableNode(axis, 'angle', 'angle', '0', 'float', 0);
    replacement.gdbVarName = 'angle';
    axis.children[0] = replacement;
    LiveWatchTreeProvider.bumpSubscription();
    provider.refresh(session, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(samples[1].values[path], 1.25);
    provider.setPlotPaths(new Set());
    LiveWatchTreeProvider.session = undefined;
    console.log('Live Plot: stable sampling plan, narrow collapsed paths, matrix isolation and fresh samples passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
