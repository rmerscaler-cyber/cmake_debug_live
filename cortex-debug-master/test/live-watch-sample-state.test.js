const assert = require('assert');
const Module = require('module');

const vscode = {
    TreeItem: class TreeItem {
        constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class ThemeIcon { },
    ThemeColor: class ThemeColor { },
    EventEmitter: class EventEmitter {
        constructor() { this.event = () => ({ dispose() { } }); }
        fire() { }
    },
    workspace: {
        getConfiguration: () => ({ get: (_name, fallback) => fallback }),
        onDidChangeConfiguration: () => ({ dispose() { } })
    },
    window: {
        createOutputChannel: () => ({ appendLine() { }, dispose() { } })
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

const { VariableObject } = require('../out/src/backend/backend.js');
const { LiveVariableNode, LiveWatchTreeProvider } = require('../out/src/frontend/views/live-watch.js');

function varObject(name, type, numchild, value) {
    const variable = new VariableObject(0, [
        ['name', name], ['exp', name], ['numchild', String(numchild)],
        ['type', type], ['value', value]
    ]);
    variable.id = 257;
    return variable;
}

assert.strictEqual(varObject('cycle_count', 'uint32_t', 0, '0').toProtocolVariable().variablesReference, 0);
assert.strictEqual(varObject('cycle_count', 'uint32_t', 0, '0').toProtocolEvaluateResponseBody().variablesReference, 0);
assert.strictEqual(varObject('statistics', 'statistics_t', 2, '{...}').toProtocolVariable().variablesReference, 257);

const root = new LiveVariableNode(undefined, '', '');
const leaf = new LiveVariableNode(root, 'cycle_count', 'gimbal_task_statistics.cycle_count', '0', 'uint32_t', 0);
leaf.setTypeInfo('uint32_t', 'scalar');
LiveWatchTreeProvider.session = { id: 'test' };

assert.strictEqual(leaf.getViewRow(0, false).value, '等待首次采样');
assert.strictEqual(leaf.getViewRow(0, false).changed, false);
assert.strictEqual(leaf.getTreeItem().collapsibleState, vscode.TreeItemCollapsibleState.None);
assert.strictEqual(leaf.isActiveContainer(), false);
assert.strictEqual(leaf.getPlotValue(), undefined);

leaf.applyFrameValues(new Map([['var1', '42']]), new Map(), []);
assert.strictEqual(leaf.getViewRow(0, false).value, '等待首次采样', 'unmapped values must not change the row');
leaf.gdbVarName = 'var1';
leaf.applyFrameValues(new Map([['var1', '42']]), new Map(), []);
assert.strictEqual(leaf.getViewRow(0, false).value, '42');
assert.strictEqual(leaf.getViewRow(0, false).changed, false, 'first real sample is the baseline');
leaf.applyFrameValues(new Map([['var1', '42']]), new Map(), []);
assert.strictEqual(leaf.getViewRow(0, false).changed, false);
leaf.applyFrameValues(new Map([['var1', '43']]), new Map(), []);
assert.strictEqual(leaf.getViewRow(0, false).changed, true, 'only a changed real sample highlights');

const watchedStruct = new LiveVariableNode(root, 'chassis_move', 'chassis_move', '{...}', 'chassis_move_t', 300);
watchedStruct.setMonitorAll(true);
const motorPointer = new LiveVariableNode(watchedStruct, 'yaw_motor', 'chassis_move.yaw_motor',
    '0x20000010', 'motor_handle_t', 0);
motorPointer.setTypeInfo('motor_handle_t', 'pointer');
assert.strictEqual(motorPointer.isActiveContainer(), true,
    'all-fields watch follows the first motor handle');
const nestedPointer = new LiveVariableNode(motorPointer, 'config', 'config', '0x20000020', 'config_t *', 0);
nestedPointer.setTypeInfo('config_t *', 'pointer');
assert.strictEqual(nestedPointer.isActiveContainer(), false,
    'automatic traversal stops at the next pointer');
motorPointer.gdbVarName = 'motorptr';
motorPointer.applyFrameValues(new Map([['motorptr', '0x20000010']]), new Map(), []);
assert.strictEqual(motorPointer.getViewRow(0, false).value, '0x20000010',
    'typedef pointers retain their address format');

console.log('Live Watch discovery and sample-state checks passed');

(async () => {
    const calls = [];
    const session = {
        id: 'progressive-discovery',
        customRequest(command, args) {
            calls.push([command, args]);
            if (command === 'liveEvaluate') {
                return Promise.resolve({
                    result: '{...}', type: 'gimbal_control_t', typeKind: 'struct',
                    gdbVarName: 'gimbal', variablesReference: 100
                });
            }
            if (args.variablesReference === 100) {
                return Promise.resolve({ variables: [{
                    name: 'axis', value: '{...}', type: 'axis_t', typeKind: 'struct',
                    gdbVarName: 'axis', variablesReference: 101
                }] });
            }
            if (args.variablesReference === 101) {
                return Promise.resolve({ variables: [{
                    name: 'angle', value: '0', type: 'float', typeKind: 'scalar',
                    gdbVarName: 'angle', variablesReference: 0
                }] });
            }
            throw new Error(`Unexpected reference ${args.variablesReference}`);
        }
    };
    LiveWatchTreeProvider.session = session;
    const all = new LiveVariableNode(undefined, '', '');
    all.addNewExpr('gimbal_control');
    const gimbal = all.getLoadedChildren()[0];
    gimbal.setMonitorAll(true);
    await all.refresh(session, undefined, true);
    assert.deepStrictEqual(calls.map(([command, args]) =>
        command === 'liveVariables' ? args.variablesReference : command), ['liveEvaluate', 100],
    'first discovery pass must stop after direct children');
    const axis = gimbal.getLoadedChildren()[0];
    assert.strictEqual(axis.needsDiscovery(), true);
    await axis.discoverChildrenShallow();
    assert.strictEqual(calls[2][1].variablesReference, 101);
    assert.strictEqual(axis.getLoadedChildren()[0].getViewRow(2, false).value, '等待首次采样');
    console.log('Live Watch progressive-discovery checks passed');

    let releaseSlowFields;
    const slowFields = new Promise((resolve) => {
        releaseSlowFields = resolve;
    });
    const requests = [];
    const liveSession = {
        id: 'sampling-during-discovery',
        configuration: {},
        customRequest(command, args) {
            requests.push([command, args]);
            if (command === 'liveCacheRefresh') {
                const count = requests.filter(([name]) => name === 'liveCacheRefresh').length;
                return Promise.resolve(count === 1
                    ? { mode: 'legacy', changes: [], readMs: 0, rebuild: false }
                    : {
                            mode: 'bulk', changes: [{ name: 'count', value: '123' }], rebuild: false,
                            frame: { stats: { successfulFieldCount: 1, blockCount: 1, receivedBytes: 4 } }
                        });
            }
            if (command === 'liveEvaluate') {
                return Promise.resolve(args.expression === 'gimbal_control'
                    ? { result: '{...}', type: 'gimbal_t', typeKind: 'struct',
                            gdbVarName: 'gimbal', variablesReference: 200 }
                    : { result: '0', type: 'uint32_t', typeKind: 'scalar',
                            gdbVarName: 'count', variablesReference: 0 });
            }
            if (command === 'liveVariables') { return slowFields; }
            throw new Error(`Unexpected command ${command}`);
        }
    };
    const context = {
        subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() }
    };
    const provider = new LiveWatchTreeProvider(context);
    provider.variables.addNewExpr('gimbal_control');
    provider.variables.addNewExpr('gimbal_task_statistics.cycle_count');
    provider.variables.getLoadedChildren()[0].setMonitorAll(true);
    LiveWatchTreeProvider.session = liveSession;
    provider.isStopped = false;
    provider.startTimer = () => { };
    provider.refresh(liveSession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(provider.discoveryRootsInFlight, true);
    provider.refresh(liveSession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const counter = provider.variables.getLoadedChildren()[1];
    assert.strictEqual(counter.getViewRow(0, false).value, '123',
        'a fast root must sample while another root is still discovering fields');
    assert.strictEqual(provider.sampleTimes.length, 1);
    assert.ok(requests.some(([name, args]) => name === 'liveCacheRefresh'
        && args.subscription?.some((node) => node.id === 'count')));
    releaseSlowFields({ variables: [] });
    console.log('Live Watch sampling-during-discovery checks passed');

    const offline = new LiveWatchTreeProvider(context);
    offline.variables.addNewExpr('gimbal_control');
    let offlineCalls = 0;
    const offlineSession = {
        id: 'no-live-gdb',
        customRequest() {
            offlineCalls++;
            return Promise.resolve({ mode: 'unavailable', error: 'GDB handshake failed' });
        }
    };
    LiveWatchTreeProvider.session = offlineSession;
    offline.isStopped = false;
    offline.startTimer = () => {
        throw new Error('failed connection must not be polled');
    };
    offline.refresh(offlineSession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(offlineCalls, 1);
    assert.strictEqual(offline.discoveryRootsInFlight, false);
    assert.strictEqual(offline.refreshError, 'GDB handshake failed');
    console.log('Live Watch unavailable-session checks passed');

    const bulkRequests = [];
    const bulkSession = {
        id: 'add-watch-during-bulk', configuration: {},
        customRequest(command, args) {
            bulkRequests.push([command, args]);
            if (command === 'liveCacheRefresh') {
                return Promise.resolve({
                    mode: 'bulk', changes: [{ name: 'existing_var', value: '7' }], rebuild: false,
                    frame: { stats: { successfulFieldCount: 1, blockCount: 1, receivedBytes: 4 } }
                });
            }
            if (command === 'liveEvaluate') {
                return Promise.resolve({
                    result: '{...}', type: 'new_t', typeKind: 'struct',
                    gdbVarName: 'new_var', variablesReference: 300
                });
            }
            if (command === 'liveVariables') {
                return Promise.resolve({ variables: [{
                    name: 'counter', value: '0', type: 'uint32_t', typeKind: 'scalar',
                    gdbVarName: 'new_counter', variablesReference: 0
                }] });
            }
            throw new Error(`Unexpected command ${command}`);
        }
    };
    const duringBulk = new LiveWatchTreeProvider(context);
    duringBulk.variables.addNewExpr('existing');
    duringBulk.variables.getLoadedChildren()[0].gdbVarName = 'existing_var';
    duringBulk.variables.addNewExpr('new_struct');
    const newStruct = duringBulk.variables.getLoadedChildren()[1];
    newStruct.setMonitorAll(true);
    LiveWatchTreeProvider.session = bulkSession;
    duringBulk.isStopped = false;
    duringBulk.startTimer = () => { };
    duringBulk.refresh(bulkSession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(newStruct.getGdbVarName(), 'new_var',
        'a new watch must be discovered while older watches use bulk sampling');
    assert.strictEqual(newStruct.getLoadedChildren()[0].getGdbVarName(), 'new_counter');
    duringBulk.refresh(bulkSession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bulkRequests.some(([name, args]) => name === 'liveCacheRefresh'
        && args.subscription?.some((node) => node.id === 'new_counter')),
    'the newly discovered field must enter the next sampling subscription');
    duringBulk.variables.reset(true);
    assert.strictEqual(newStruct.getGdbVarName(), undefined,
        'old GDB variable names must not leak into a new debug session');
    console.log('Live Watch add-during-bulk checks passed');

    const compatibility = new LiveWatchTreeProvider(context);
    compatibility.startTimer = () => {};
    compatibility.isStopped = false;
    const legacyRoot = compatibility.variables.addChild('motor', 'motor', '{...}', 'motor_t', 501);
    legacyRoot.gdbVarName = 'motor';
    legacyRoot.expanded = true;
    const legacyAngle = legacyRoot.addChild('angle', 'angle', '0', 'float', 0);
    legacyAngle.gdbVarName = 'angle';
    const legacySession = {
        id: 'legacy-rebuild-values', configuration: {},
        customRequest(command) {
            if (command === 'liveCacheRefresh') {
                return Promise.resolve({ mode: 'legacy', changes: [{ name: 'angle', value: '1.25' }], rebuild: true });
            }
            if (command === 'liveEvaluate') {
                return Promise.resolve({ result: '{...}', type: 'motor_t', gdbVarName: 'motor', variablesReference: 501 });
            }
            return Promise.resolve({ variables: [{ name: 'angle', value: '0', type: 'float',
                gdbVarName: 'angle', variablesReference: 0 }] });
        }
    };
    legacyRoot.session = legacySession;
    LiveWatchTreeProvider.session = legacySession;
    compatibility.refresh(legacySession, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(legacyAngle.getViewRow(1, false).value, '1.25',
        'legacy values must reach the UI even while the tree is rebuilding');

    const pointerParent = new LiveVariableNode(compatibility.variables, 'motors', 'motors', '{...}', 'motor_handle_t [4]', 600);
    const handle = pointerParent.addChild('0', 'motors[0]', '0x20000010', 'motor_handle_t', 0);
    handle.setTypeInfo('motor_handle_t', 'pointer');
    handle.expanded = true;
    pointerParent.expanded = true;
    pointerParent.session = legacySession;
    pointerParent.setTypeInfo('motor_handle_t [4]', 'array');
    legacySession.customRequest = () => Promise.resolve({ variables: [{ name: '0', value: '0x20000010',
        type: 'motor_handle_t', typeKind: 'pointer', gdbVarName: 'handle', variablesReference: 0 }] });
    await pointerParent.discoverChildrenShallow();
    assert.strictEqual(handle.expanded, true, 'remapping a pointer with reference zero must preserve manual expansion');
    handle.setMonitorAll(true);
    legacyRoot.setMonitorAll(true);
    compatibility.variables.collapseForNewSession();
    assert.strictEqual(legacyRoot.expanded, false);
    assert.strictEqual(legacyRoot.isMonitorAll(), false, 'new sessions disable restored all-field sampling');
    console.log('Legacy UI: rebuilding values, pointer expansion and collapsed session defaults passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
