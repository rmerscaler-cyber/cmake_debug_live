const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './gdb' && parent.filename.endsWith('/live-watch-monitor.js')) {
        return { RequestQueue: class {} };
    }
    if (request === 'vscode') { return {}; }
    return originalLoad.call(this, request, parent, isMain);
};
const { VariablesHandler, LiveWatchMonitor } = require('../out/src/live-watch-monitor');
const { VariableObject } = require('../out/src/backend/backend');
const { parseMI } = require('../out/src/backend/mi_parse');
Module._load = originalLoad;
const handler = new VariablesHandler(() => false, () => {});
function add(name, type, count, value, kind) {
    const variable = new VariableObject(1, [
        ['name', name], ['exp', name], ['type', type], ['numchild', String(count)], ['value', value]
    ]);
    variable.typeKind = kind;
    handler.findOrCreateVariable(variable);
    return variable;
}
const pointer = add('motor', 'motor_handle_t', 1, '0x20000000', 'pointer');
const angle = add('angle', 'float', 0, '1.25', 'scalar');
add('hidden', 'float', 0, '99', 'scalar');
const subscription = new Set(['motor', 'angle']);
let response = '^done,changelist=[]';
const freezeCommands = [];
const debuggerStub = {
    varUpdate: async () => parseMI(response),
    sendCommand: async (command) => freezeCommands.push(command)
};
(async () => {
    const first = await handler.refreshCachedChangeList(debuggerStub, true, subscription);
    assert.strictEqual(first.changes.find((change) => change.name === 'angle').value, '1.25',
        'an unchanged angle must establish its first real legacy sample');
    assert.strictEqual(first.changes.find((change) => change.name === 'motor').value, '0x20000000',
        'a pointer with GDB children still needs its address sampled');
    assert(!first.changes.some((change) => change.name === 'hidden'), 'collapsed branches are excluded');
    assert.deepStrictEqual(freezeCommands, ['var-set-frozen hidden 1'], 'collapsed GDB fields stop background updates');
    response = '^done,changelist=[{name="motor",value="0x20000000",in_scope="true",'
        + 'type_changed="false",new_num_children="1",has_more="0"},'
        + '{name="angle",value="2.5",in_scope="true",type_changed="false",has_more="0"}]';
    const stable = await handler.refreshCachedChangeList(debuggerStub, true, subscription);
    assert.strictEqual(stable.rebuild, false, 'unchanged child metadata must not rebuild every frame');
    assert.strictEqual(stable.changes.find((change) => change.name === 'angle').value, '2.5');
    assert.strictEqual(freezeCommands.length, 1, 'steady frames must not repeat freeze commands');
    await handler.refreshCachedChangeList(debuggerStub, true, new Set(['motor', 'angle', 'hidden']));
    assert.strictEqual(freezeCommands.at(-1), 'var-set-frozen hidden 0', 'expanding a field resumes its GDB updates');
    response = '^done,changelist=[{name="motor",value="0x20000100",in_scope="true",type_changed="false"},'
        + '{name="angle",value="3.5",in_scope="true",type_changed="false"}]';
    const moved = await handler.refreshCachedChangeList(debuggerStub, true, subscription);
    assert.strictEqual(moved.rebuild, true, 'a typedef pointer moving must rebuild its target');
    assert.strictEqual(pointer.value, '0x20000100');
    assert.strictEqual(moved.changes.find((change) => change.name === 'angle').value, '3.5',
        'a rebuilding frame must retain subsequent scalar samples');
    response = '^done,changelist=[{name="motor",in_scope="false",type_changed="false"},'
        + '{name="angle",value="4.5",in_scope="true",type_changed="false"}]';
    const missing = await handler.refreshCachedChangeList(debuggerStub, true, subscription);
    assert.strictEqual(missing.rebuild, true);
    assert(!missing.changes.some((change) => change.name === 'motor'), 'out-of-scope values cannot appear current');
    assert.strictEqual(missing.unavailable[0].name, 'motor');
    assert.strictEqual(angle.value, '4.5');
    const monitor = new LiveWatchMonitor({});
    monitor.varHandler = handler;
    monitor.miDebugger = debuggerStub;
    monitor.engine = { setSubscription() {}, sample: async () => ({
        values: [], stats: { phase: 'unsupported' }, useLegacy: true
    }) };
    response = '^done,changelist=[]';
    const frame = await monitor.refreshLiveCache({ revision: 1, subscription: [{ id: 'angle' }] });
    assert.strictEqual(frame.mode, 'legacy');
    assert.deepStrictEqual(frame.changes, [{ name: 'angle', value: '4.5' }]);
    console.log('Legacy Live Watch: unchanged first samples, stable metadata, moving pointers, rebuilding frames and visible subscriptions passed');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-legacy-gdb-'));
    try {
        const source = path.join(directory, 'motor.cpp');
        const executable = path.join(directory, 'motor');
        fs.writeFileSync(source, 'struct Feedback { float angle; unsigned count; }; '
            + 'struct Motor { unsigned id; Feedback fb; }; Motor motor={1,{1.25f,7}}; '
            + 'Motor* handle=&motor; int main(){return 0;}\n');
        execFileSync('g++', ['-g', '-O0', source, '-o', executable]);
        const commands = [
            '1-break-insert main', '2-exec-run', '3-var-create watch @ handle',
            '4-var-list-children --all-values watch', '5-var-list-children --all-values watch.public',
            '6-var-list-children --all-values watch.public.fb',
            '7-var-list-children --all-values watch.public.fb.public', '8-var-update --simple-values *',
            '9-gdb-set var motor.fb.angle=2.5', '10-var-update --simple-values *',
            '11-var-update --simple-values *', '12-var-set-frozen watch.public.fb.public.angle 1',
            '13-gdb-set var motor.fb.angle=3.75', '14-var-update --simple-values *',
            '15-var-set-frozen watch.public.fb.public.angle 0', '16-var-update --simple-values *', '17-gdb-exit'
        ];
        const run = spawnSync('gdb', ['-q', '-nx', '--interpreter=mi2', executable], {
            input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 15000
        });
        assert.strictEqual(run.status, 0, run.stdout + run.stderr);
        const record = (token) => {
            const line = run.stdout.split('\n').find((text) => text.startsWith(`${token}^done`));
            assert(line, run.stdout + run.stderr);
            return parseMI(line);
        };
        const real = new VariablesHandler(() => false, () => {});
        const realPointer = new VariableObject(0, record(3).resultRecords.results);
        realPointer.typeKind = 'pointer';
        real.findOrCreateVariable(realPointer);
        for (const child of record(7).result('children')) {
            real.findOrCreateVariable(new VariableObject(1, child[1]));
        }
        const angleName = 'watch.public.fb.public.angle';
        let token = 8;
        const transport = { varUpdate: async () => record(token) };
        const baseline = await real.refreshCachedChangeList(transport, true);
        assert.match(baseline.changes.find((value) => value.name === 'watch').value, /0x/);
        assert.strictEqual(baseline.changes.find((value) => value.name === angleName).value, '1.25');
        token = 10;
        const changed = await real.refreshCachedChangeList(transport, true);
        assert.strictEqual(changed.rebuild, false, 'real GDB has_more=0 must not force a rebuild');
        assert.strictEqual(changed.changes.find((value) => value.name === angleName).value, '2.5');
        token = 11;
        const unchanged = await real.refreshCachedChangeList(transport, true);
        assert.strictEqual(unchanged.changes.find((value) => value.name === angleName).value, '2.5');
        assert.deepStrictEqual(record(14).result('changelist'), [], 'frozen branches are skipped by real GDB');
        token = 16;
        const expanded = await real.refreshCachedChangeList(transport, true);
        assert.strictEqual(expanded.changes.find((value) => value.name === angleName).value, '3.75',
            'real GDB resumes updates after manual expansion');
        console.log('Actual GDB MI: pointer feedback first sample, changed angle with has_more=0 and unchanged frames passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
