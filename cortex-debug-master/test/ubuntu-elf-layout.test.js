// Run with: node test/ubuntu-elf-layout.test.js <arm-gdb-or-gdb-multiarch> <test_cortex-debug-elf>
const assert = require('assert');
const { spawnSync } = require('child_process');
const { TypeResolver } = require('../out/src/backend/live-memory-types');

const [gdb, elf] = process.argv.slice(2);
assert(gdb && elf, 'Provide GDB and the Debug ELF built from test_cortex');
function consoleCommand(command) {
    const result = spawnSync(gdb, ['--batch', '-nx', elf, '-ex', command], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout;
}
const resolver = new TypeResolver({
    console: async (command) => consoleCommand(command),
    evaluate: async (expression) => /^\$\d+ = (.*)$/m.exec(consoleCommand(`print ${expression}`))?.[1]?.trim() || ''
});
(async () => {
    for (const [type, size] of [['rc_ctrl', 28], ['LedTimingDebug', 12], ['LedDebugSnapshot', 1264]]) {
        const layout = await resolver.resolveTypeText(type);
        assert(layout && layout.kind === 'struct', `${type}: expected a struct`);
        assert.strictEqual(layout.byteSize, size, `${type}: ARM layout size`);
    }
    const snapshot = await resolver.resolveTypeText('LedDebugSnapshot');
    assert.strictEqual(snapshot.members.find((member) => member.name === 'blink_frequency_hz').type.kind, 'float');
    assert.strictEqual(snapshot.members.find((member) => member.name === 'timing').type.kind, 'struct');
    assert.strictEqual(snapshot.members.find((member) => member.name === 'transition_handler').type.kind, 'function-pointer');
    const history = snapshot.members.find((member) => member.name === 'frequency_history_millihz');
    assert.deepStrictEqual(history.arrayDims, [300]);
    assert.strictEqual(history.byteSize, 1200);
    console.log('Live Watch real STM32 ELF: structures, floats, nested fields, function pointers and paged arrays passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
