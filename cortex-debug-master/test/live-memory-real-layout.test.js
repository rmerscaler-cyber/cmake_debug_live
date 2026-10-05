// Run manually with: node test/live-memory-real-layout.test.js <arm-gdb> <debug-elf>
// This checks the complete recursive type resolver against the project's ELF.
const assert = require('assert');
const { spawnSync } = require('child_process');
const { TypeResolver } = require('../out/src/backend/live-memory-types.js');

const gdb = process.argv[2];
const elf = process.argv[3];
if (!gdb || !elf) {
    throw new Error('Pass the GDB executable and a Debug ELF as arguments.');
}

function command(line) {
    const elfForGdb = elf.replace(/\\/g, '/');
    const result = spawnSync(gdb, ['--batch', '-nx', '-ex', `file "${elfForGdb}"`, '-ex', line], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
        throw result.error || new Error(result.stderr || `GDB exited with ${result.status}`);
    }
    return result.stdout;
}

const queried = [];
const resolver = new TypeResolver({
    console: async (line) => {
        queried.push(line);
        return command(line);
    },
    evaluate: async (expression) => {
        const output = command(`print ${expression}`);
        return /^\$\d+ = (.*)$/m.exec(output)?.[1]?.trim() || '';
    }
});

(async () => {
    for (const [type, size] of [['rc_ctrl', 28], ['chassis_move_t', 404], ['motor_base_t', 348]]) {
        const layout = await resolver.resolveTypeText(type);
        assert(layout && layout.kind === 'struct', `${type} did not resolve as a struct`);
        assert.strictEqual(layout.byteSize, size, `${type} size`);
        console.log(`${type}: ${layout.members.length} members, ${size} bytes`);
    }
    // GDB's `ptype /o motor_handle_t` expands the typedef to the pointee
    // struct; the resolver must use whatis and keep it a pointer.
    const handle = await resolver.resolveTypeText('motor_handle_t');
    assert(handle && handle.kind === 'pointer', `motor_handle_t resolved as ${handle && handle.kind}`);
    console.log(`motor_handle_t: pointer -> ${handle.pointeeTypeText}`);
    const chassis = await resolver.resolveTypeText('chassis_move_t');
    const steer = chassis.members.find((member) => member.name === 'steer_motor');
    assert(steer && steer.type && steer.type.kind === 'pointer', 'steer_motor members must be pointers');
    console.log(`chassis_move.steer_motor: pointer[${steer.arrayDims}]`);
    console.log(`Resolved with ${queried.length} console queries.`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
