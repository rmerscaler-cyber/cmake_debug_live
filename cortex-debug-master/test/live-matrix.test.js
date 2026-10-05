const assert = require('assert');
const Module = require('module');
const { parseMatrixShape } = require('../out/src/live-matrix');
const { LiveMatrixReader } = require('../out/src/backend/live-matrix-reader');
const { TypeResolver } = require('../out/src/backend/live-memory-types');

const columnShape = parseMatrixShape('class Eigen::Matrix<double, 2, 3, 0, 2, 3>');
const rowShape = parseMatrixShape('Eigen::Matrix<double, 2, 3, 1, 2, 3>');
assert.deepStrictEqual([columnShape.rows, columnShape.columns, columnShape.rowMajor], [2, 3, false]);
assert.strictEqual(rowShape.rowMajor, true);
assert.strictEqual(parseMatrixShape('Eigen::Matrix<double, 12, 1, 0, 12, 1>').rows, 12);
assert.strictEqual(parseMatrixShape('Eigen::Matrix<double, -1, -1, 0, -1, -1>'), undefined);
assert.strictEqual(parseMatrixShape('Eigen::MatrixBase<Eigen::Matrix<double, 2, 3, 0, 2, 3> >'), undefined);
assert.strictEqual(parseMatrixShape('Eigen::Matrix<double, 10000, 10000>'), undefined);
assert.strictEqual(parseMatrixShape('motor_handle_t [4]'), undefined);
assert.strictEqual(parseMatrixShape('double [16]').automatic, false);
assert.strictEqual(parseMatrixShape('float [2][3]').automatic, true);
assert.strictEqual(parseMatrixShape('int [2][3][4]'), undefined);

async function readerChecks() {
    let address = 0x20000100;
    let fail = false;
    const commands = [];
    const reads = [];
    const buffer = Buffer.alloc(48);
    [0, 10, 1, 11, 2, 12].forEach((value, index) => buffer.writeDoubleLE(value, index * 8));
    const transport = {
        varInfoPathExpression: async () => 'arm_application.T_sy',
        sendCliCommand: async (command) => {
            commands.push(command);
            assert.strictEqual(command, 'show endian');
            return 'The target endianness is set automatically (currently little endian)';
        },
        evaluateNumber: async (expression) => {
            commands.push(expression);
            if (expression === 'sizeof((arm_application.T_sy).m_storage.m_data.array[0])') { return '8'; }
            if (expression === 'sizeof((arm_application.T_sy).m_storage.m_data.array)') { return '48'; }
            if (expression === '&((arm_application.T_sy).m_storage.m_data.array[0])') { return String(address); }
            throw new Error('Unexpected evaluation: ' + expression);
        },
        readMemoryRange: async (base, length) => {
            reads.push([base, length]);
            if (fail) { throw new Error('USB disconnected'); }
            return { data: buffer.subarray(0, length) };
        }
    };
    const resolver = new TypeResolver({ console: async () => {
        throw new Error('No parent layout query allowed');
    },
    evaluate: async () => '4' });
    const reader = new LiveMatrixReader(transport, resolver);
    const request = { id: 'matrix', rows: 2, columns: 3 };
    const first = await reader.sample(request, columnShape);
    assert.deepStrictEqual(first.values, ['0', '1', '2', '10', '11', '12'], 'column-major Eigen storage must display logical rows');
    assert.deepStrictEqual(reads, [[0x20000100, 48]], 'one block read for all six elements');
    const count = commands.length;
    address = 0x20000200;
    buffer.writeDoubleLE(42, 0);
    const second = await reader.sample(request, columnShape);
    assert.strictEqual(second.values[0], '42');
    assert.strictEqual(reads.at(-1)[0], address, 'a moving pointer changes the next frame address');
    assert.strictEqual(commands.length - count, 1, 'steady state only resolves one address, without type/layout queries');
    const rowReader = new LiveMatrixReader(transport, resolver);
    [0, 1, 2, 10, 11, 12].forEach((value, index) => buffer.writeDoubleLE(value, index * 8));
    assert.deepStrictEqual((await rowReader.sample(request, rowShape)).values, ['0', '1', '2', '10', '11', '12']);
    fail = true;
    const unavailable = await reader.sample(request, columnShape);
    assert.deepStrictEqual(unavailable.values, [], 'failure must not present the last successful values as current');
    assert.match(unavailable.error, /USB disconnected/);
    fail = false;
    assert.strictEqual((await reader.sample(request, columnShape)).values.length, 6);
    assert.match((await reader.sample({ ...request, rows: 3, columns: 2 }, columnShape)).error, /行列数/);
    const badSize = new LiveMatrixReader({ ...transport, evaluateNumber: async () => '8' }, resolver);
    assert.match((await badSize.sample(request, columnShape)).error, /存储大小/);
    const canonicalArray = '((((arm_application).T_sy).m_storage).m_data).array';
    const internalReader = new LiveMatrixReader({
        ...transport,
        varInfoPathExpression: async () => { throw new Error('Synthetic Eigen base path must not be evaluated'); },
        sendCliCommand: async (command) => command === 'show endian' ? 'little endian' : 'type = double [6]',
        evaluateNumber: async (expression) => {
            if (expression === `sizeof((${canonicalArray})[0])`) { return '8'; }
            if (expression === `sizeof((${canonicalArray}))`) { return '48'; }
            if (expression === `&((${canonicalArray})[0])`) { return String(address); }
            throw new Error(`Unexpected storage expression: ${expression}`);
        }
    }, resolver, () => canonicalArray);
    assert.deepStrictEqual((await internalReader.sample({ id: 'internal-array', rows: 2, columns: 3 },
        parseMatrixShape('double [6]'))).values, ['0', '1', '2', '10', '11', '12']);
    console.log('Matrix reader: row/column order, one block read, moving addresses, failed/recovered frames and size validation passed.');
}

function frontendChecks() {
    const originalLoad = Module._load;
    const vscode = {
        TreeItem: class {
            constructor(label, state) {
                this.label = label;
                this.collapsibleState = state;
            }
        },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class {}, ThemeColor: class {},
        EventEmitter: class {
            constructor() {
                this.listeners = new Set();
                this.event = (listener) => {
                    this.listeners.add(listener);
                    return { dispose: () => this.listeners.delete(listener) };
                };
            }

            fire(value) {
                for (const listener of this.listeners) {
                    listener(value);
                }
            }
        },
        workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
        window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
    };
    Module._load = function (name, parent, isMain) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
    };
    const { LiveVariableNode, LiveWatchTreeProvider } = require('../out/src/frontend/views/live-watch');
    const root = new LiveVariableNode(undefined, '', '');
    const application = new LiveVariableNode(root, 'arm_application', 'arm_application', '{...}', 'app_t', 1);
    application.expanded = true;
    application.gdbVarName = 'app';
    const matrix = new LiveVariableNode(application, 'T_sy', 'arm_application.T_sy', '{...}', 'M4', 2);
    matrix.gdbVarName = 'matrix';
    root.children = [application];
    application.children = [matrix];
    matrix.setMatrixInfo(columnShape);
    assert.strictEqual(matrix.usesMatrixDisplay(), true);
    assert.strictEqual(matrix.expanded, false, 'recognizing a matrix must leave it collapsed');
    assert.strictEqual(matrix.getMatrixRequest(), undefined, 'collapsed matrices do not sample storage');
    assert.strictEqual(matrix.needsDiscovery(), false, 'matrix grids must not discover Eigen inheritance internals');
    matrix.applyMatrixSamples(new Map([['matrix', { name: 'matrix', values: ['0', '1', '2', '10', '11', '12'] }]]), []);
    assert.deepStrictEqual(matrix.getViewRow(1, false).matrix.changed, Array(6).fill(false));
    matrix.applyMatrixSamples(new Map([['matrix', { name: 'matrix', values: ['5', '1', '2', '10', '11', '12'] }]]), []);
    assert.deepStrictEqual(matrix.getViewRow(1, false).matrix.changed, [true, false, false, false, false, false]);
    matrix.applyMatrixSamples(new Map([['matrix', { name: 'matrix', values: [], error: 'not readable' }]]), []);
    assert.deepStrictEqual(matrix.getViewRow(1, false).matrix.values, []);
    const state = root.serialize();
    matrix.displayMode = 'tree';
    assert.strictEqual(matrix.usesMatrixDisplay(), false);
    const context = { workspaceState: { get: () => undefined, update() {} }, subscriptions: [] };
    const provider = new LiveWatchTreeProvider(context);
    provider.variables = root;
    LiveWatchTreeProvider.session = { id: 'matrix-test' };
    provider.setViewDisplayMode(matrix.getPlotPath(), 'matrix');
    assert.strictEqual(matrix.expanded, false, 'display selection must not auto-expand a matrix');
    assert.strictEqual(provider.getViewRows().length, 2, 'a grid replaces all internal Eigen rows');
    assert.deepStrictEqual(provider.collectMatrixRequests(), []);
    matrix.expanded = true;
    assert.deepStrictEqual(provider.collectMatrixRequests(), [{ id: 'matrix', rows: 2, columns: 3 }]);
    application.expanded = false;
    assert.deepStrictEqual(provider.collectMatrixRequests(), [], 'collapsed parents unsubscribe their hidden matrices');
    application.expanded = true;
    // The sidebar receives frames through onDidUpdateValues, without a TreeView.
    const samples = [];
    provider.onDidUpdateValues((sample) => samples.push(sample));
    provider.isStopped = false;
    LiveWatchTreeProvider.notifyValuePanel(true);
    const complete = (values, error) => {
        provider.pendingMatrixSamples = [{ name: 'matrix', values, error }];
        provider.finishSample(LiveWatchTreeProvider.session, [], true, false);
        return samples.at(-1).rows[1].matrix;
    };
    assert.deepStrictEqual(complete(['0', '1', '2', '10', '11', '12']).values,
        ['0', '1', '2', '10', '11', '12']);
    const changed = complete(['42', '1', '2', '10', '11', '12']);
    assert.strictEqual(changed.values[0], '42', 'changing matrix values reach the sidebar stream');
    assert.strictEqual(changed.changed[0], true);
    assert(Number.isFinite(changed.timestampMs), 'each sampled matrix carries its refresh time');
    const failed = complete([], 'read failed');
    assert.deepStrictEqual(failed.values, [], 'failed matrix-only frames clear displayed values');
    assert.strictEqual(failed.error, 'read failed', 'failed frames must reach the sidebar too');
    provider.isStopped = true;
    const paused = complete(['99', '1', '2', '10', '11', '12']);
    assert.strictEqual(paused.values[0], '99', 'paused refresh publishes current matrix values');
    assert(paused.changed.every((value) => !value), 'paused values do not keep change highlights');
    assert.strictEqual(samples.length, 4, 'success, change, failure and paused frames all publish');
    LiveWatchTreeProvider.notifyValuePanel(false);
    matrix.reset();
    assert.strictEqual(matrix.getViewRow(1, false).matrix, undefined, 'session reset clears shape/data');
    const restored = new LiveVariableNode(undefined, '', '');
    restored.deSerialize(state);
    assert.strictEqual(restored.children[0].children[0].displayMode, 'auto');
    const flat = new LiveVariableNode(root, 'flat', 'flat', '{...}', 'double [16]', 3);
    flat.setMatrixInfo(parseMatrixShape('double [16]'));
    assert.strictEqual(flat.usesMatrixDisplay(), false, 'one-dimensional C arrays keep the default tree');
    assert.strictEqual(flat.setMatrixDimensions(4, 4), true);
    assert.strictEqual(flat.setMatrixDimensions(3, 3), false);
    flat.displayMode = 'matrix';
    assert.deepStrictEqual([flat.getMatrixShape().rows, flat.getMatrixShape().columns], [4, 4]);
    Module._load = originalLoad;
    console.log('Matrix watch: auto recognition, tree/grid switching, subscriptions, highlights, reshape, persistence and session reset passed.');
}

async function monitorChecks() {
    const originalLoad = Module._load;
    Module._load = function (name, parent, isMain) {
        if (name === './gdb' && parent.filename.endsWith('/live-watch-monitor.js')) { return { RequestQueue: class {} }; }
        if (name === 'vscode') { return {}; }
        return originalLoad.call(this, name, parent, isMain);
    };
    const { LiveWatchMonitor, VariablesHandler } = require('../out/src/live-watch-monitor');
    const { VariableObject } = require('../out/src/backend/backend');
    const handler = new VariablesHandler(() => false, () => {});
    function add(name, type, exp, parent) {
        const variable = new VariableObject(parent ? 1 : 0,
            [['name', name], ['exp', exp], ['numchild', '1'], ['type', type], ['value', '{...}']]);
        handler.findOrCreateVariable(variable);
        if (parent) { handler.variableParents.set(name, { parent, key: exp }); }
        return variable;
    }
    add('app', 'app_t', 'arm_application');
    const alias = add('app.T_sy', 'M4', 'T_sy', 'app');
    add('app.T_sy.base', 'Eigen::PlainObjectBase<Eigen::Matrix<double, 4, 4, 0, 4, 4> >',
        'Eigen::PlainObjectBase<Eigen::Matrix<double, 4, 4, 0, 4, 4> >', alias.name);
    add('storage', 'storage_t', 'm_storage', 'app.T_sy.base');
    add('data', 'array_t', 'm_data', 'storage');
    add('array', 'double [16]', 'array', 'data');
    assert.strictEqual(handler.matrixStoragePath('array'), '((((arm_application).T_sy).m_storage).m_data).array');
    assert.strictEqual(handler.matrixStoragePath(alias.name), undefined, 'ordinary matrix paths use GDB');
    const declarations = [];
    await handler.classifyChildren({
        sendCliCommand: async (command) => {
            declarations.push(command);
            if (command === 'whatis /r M4') { return 'type = Eigen::Matrix4d'; }
            if (command === 'whatis /r \'Eigen::Matrix4d\'') { return 'type = class Eigen::Matrix<double, 4, 4, 0, 4, 4>'; }
            throw new Error(`Unnecessary type query: ${command}`);
        }
    }, [alias]);
    assert.deepStrictEqual([alias.matrix.rows, alias.matrix.columns], [4, 4], 'M4 children auto-detect through both typedefs');
    assert.strictEqual(declarations.length, 2, 'alias resolution is cached between classification and shape parsing');
    await handler.classifyChildren({}, [alias]);
    assert.strictEqual(declarations.length, 2, 'repeated discovery must not query the type again');
    const monitor = new LiveWatchMonitor({});
    const variable = new VariableObject(0, [
        ['name', 'matrix'], ['exp', 'arm_application.T_sy'], ['numchild', '1'], ['type', 'M4'], ['value', '{...}']
    ]);
    variable.matrix = columnShape;
    monitor.varHandler.findOrCreateVariable(variable);
    assert.deepStrictEqual(variable.toProtocolVariable().matrix, columnShape, 'matrix metadata is sent to the watch UI');
    const calls = [];
    monitor.miDebugger = { sendCommand: async () => ({}) };
    monitor.engine = {
        sample: async () => ({ values: [], stats: { phase: 'unsupported' }, useLegacy: true }),
        clear() {}
    };
    monitor.varHandler.refreshCachedChangeList = async () => {
        calls.push('parent-layout-fallback');
        return { changes: [], rebuild: false, readMs: 0 };
    };
    monitor.matrixReader = {
        sample: async (request) => {
            calls.push('independent-matrix');
            return { name: request.id, values: ['0', '1', '2', '10', '11', '12'] };
        },
        clear() { calls.push('clear-matrix'); }
    };
    const frame = await monitor.refreshLiveCache({ matrices: [{ id: 'matrix', rows: 2, columns: 3 }] });
    assert.strictEqual(frame.mode, 'legacy');
    assert.strictEqual(frame.matrices[0].values.length, 6, 'failed parent layout must not block matrix sampling');
    assert.deepStrictEqual(calls, ['parent-layout-fallback', 'independent-matrix']);
    assert.strictEqual((await monitor.refreshLiveCache({ matrices: [] })).matrices.length, 0);
    await monitor.refreshLiveCache({ deleteAll: true });
    assert(calls.includes('clear-matrix'));
    assert.deepStrictEqual(monitor.matrixRequests, []);
    Module._load = originalLoad;
    console.log('Matrix monitor: parent layout failure isolation, protocol metadata, unsubscribe and cache deletion passed.');
}

(async () => {
    await readerChecks();
    frontendChecks();
    await monitorChecks();
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
