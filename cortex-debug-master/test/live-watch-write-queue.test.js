const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    // Import the monitor without starting the executable DAP session in gdb.ts.
    if (request === './gdb' && parent.filename.endsWith('/live-watch-monitor.js')) {
        return { RequestQueue: class {} };
    }
    if (request === 'vscode') { return {}; }
    return originalLoad.call(this, request, parent, isMain);
};
const { LiveWatchMonitor } = require('../out/src/live-watch-monitor');
const { VariableObject } = require('../out/src/backend/backend');
const monitor = new LiveWatchMonitor({});
const variable = new VariableObject(0, [
    ['name', 'watch.kp'], ['exp', 'pid.kp'], ['numchild', '0'], ['type', 'float'], ['value', '1.25']
]);
monitor.varHandler.findOrCreateVariable(variable);
const log = [];
let finishSample;
monitor.miDebugger = { sendCommand: async (command) => log.push(command) };
monitor.engine = {
    sample: () => new Promise((resolve) => {
        log.push('sample-start');
        finishSample = () => {
            log.push('sample-end');
            resolve({ values: [], stats: { phase: 'sample', readMs: 1 }, useLegacy: false });
        };
    }),
    clear: () => log.push('clear')
};
monitor.writer = { write: async (_name, value) => {
    log.push(`write-${value}`);
    if (value === 'bad') { throw new Error('invalid value'); }
    return { value, appliedValue: value, overwritten: false };
} };
(async () => {
    const sampling = monitor.refreshLiveCache({ deleteAll: false });
    const writing = monitor.setValue({ name: 'watch.kp', value: '3.25' });
    await Promise.resolve();
    assert.deepStrictEqual(log, ['sample-start'], 'write waits for in-flight sample');
    finishSample();
    await Promise.all([sampling, writing]);
    assert.deepStrictEqual(log, ['sample-start', 'sample-end', 'write-3.25']);
    await assert.rejects(monitor.setValue({ name: 'watch.kp', value: 'bad' }));
    await monitor.setValue({ name: 'watch.kp', value: '4' });
    assert(log.includes('write-4'), 'failed write does not poison subsequent requests');
    const deleting = monitor.refreshLiveCache({ deleteAll: true });
    const stale = monitor.setValue({ name: 'watch.kp', value: '5' });
    await deleting;
    await assert.rejects(stale, /失效/);
    assert(!log.includes('write-5'), 'deleted handles cannot be written');
    console.log('Live Watch monitor: sampling/write order, failed request recovery and stale handle rejection passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
