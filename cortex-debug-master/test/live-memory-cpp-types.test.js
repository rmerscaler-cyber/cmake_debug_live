// Run after test-compile. Optional arguments: <arm-gdb> <debug-elf>.
const assert = require('assert');
const { spawnSync } = require('child_process');
const { TypeResolver, gdbTypeName } = require('../out/src/backend/live-memory-types.js');

async function mockedChecks() {
    assert.strictEqual(gdbTypeName('motor_handle_t'), 'motor_handle_t');
    assert.strictEqual(gdbTypeName('unsigned long'), 'unsigned long');
    assert.strictEqual(gdbTypeName('Eigen::internal::plain_array<double, 16, 0, 16>'),
        '\'Eigen::internal::plain_array<double, 16, 0, 16>\'');
    assert.strictEqual(gdbTypeName('struct Eigen::internal::plain_array<double, 16, 0, 16>'),
        'struct \'Eigen::internal::plain_array<double, 16, 0, 16>\'');
    const commands = [];
    const resolver = new TypeResolver({
        console: async (command) => {
            commands.push(command);
            const outputs = {
                'whatis /r \'Eigen::internal::plain_array<double, 16, 0, 16>\'': 'type = struct Eigen::internal::plain_array<double, 16, 0, 16>',
                'whatis /r \'arm_kinematics::input_t<4>::JointVector\'': 'type = class Eigen::Matrix<double, 4, 1, 0, 4, 1>',
                'whatis /r \'ns::handle_t\'': 'type = struct target_t *',
                'whatis /r \'ns::mode_t\'': 'type = enum ns::mode_t',
                'ptype /o \'ns::mode_t\'': 'type = enum ns::mode_t {IDLE = 0, ACTIVE = 1}',
                'whatis /r \'ns::data_t\'': 'type = struct ns::data_t',
                'whatis /r M4': 'type = Eigen::Matrix4d',
                'whatis /r \'Eigen::Matrix4d\'': 'type = class Eigen::Matrix<double, 4, 4, 0, 4, 4>',
                'whatis /r cycle_a': 'type = cycle_b',
                'whatis /r cycle_b': 'type = cycle_a',
                'ptype /o \'ns::data_t\'': 'type = struct ns::data_t {\n/* 0 | 8 */ double value;\n/* total size (bytes): 8 */\n}',
                // In C++ mode whatis can return the same class name without a keyword.
                'whatis /r \'Eigen::Matrix<double, 4, 4, 0, 4, 4>\'': 'type = Eigen::Matrix<double, 4, 4, 0, 4, 4>',
                'ptype /o \'Eigen::Matrix<double, 4, 4, 0, 4, 4>\'': '/* offset | size */ type = class Eigen::Matrix<double, 4, 4, 0, 4, 4> {\n}'
            };
            if (!(command in outputs)) { throw new Error(`Unexpected command: ${command}`); }
            return outputs[command];
        },
        evaluate: async (expression) => {
            commands.push(expression);
            if (expression === 'sizeof(void *)') { return '4'; }
            if (expression === 'sizeof(\'ns::mode_t\')') { return '1'; }
            if (expression === '((\'ns::mode_t\')-1) < 0') { return '0'; }
            throw new Error(`Unexpected expression: ${expression}`);
        }
    });
    assert.strictEqual(await resolver.classifyTypeText('Eigen::internal::plain_array<double, 16, 0, 16>'), 'struct');
    assert.strictEqual(await resolver.classifyTypeText('arm_kinematics::input_t<4>::JointVector'), 'struct');
    assert.strictEqual(await resolver.classifyTypeText('Eigen::Matrix<double, 4, 4, 0, 4, 4>'), 'struct');
    assert.strictEqual(await resolver.classifyTypeText('M4'), 'struct');
    assert.strictEqual(await resolver.declaredType('M4'), 'class Eigen::Matrix<double, 4, 4, 0, 4, 4>');
    assert.strictEqual(await resolver.declaredType('cycle_a'), 'cycle_a', 'typedef cycles must terminate');
    const handle = await resolver.resolveTypeText('ns::handle_t');
    assert.strictEqual(handle.kind, 'pointer', 'quoted typedef must remain a pointer');
    assert.strictEqual(handle.byteSize, 4);
    const mode = await resolver.resolveTypeText('ns::mode_t');
    assert.strictEqual(mode.kind, 'enum');
    assert.strictEqual(mode.byteSize, 1);
    assert.strictEqual(mode.signed, false);
    assert.strictEqual(mode.enumValues.get('1'), 'ACTIVE');
    const data = await resolver.resolveTypeText('ns::data_t');
    assert.strictEqual(data.members[0].type.kind, 'float');
    assert.strictEqual(data.byteSize, 8);
    const count = commands.length;
    await resolver.classifyTypeText('Eigen::internal::plain_array<double, 16, 0, 16>');
    await resolver.classifyTypeText('Eigen::Matrix<double, 4, 4, 0, 4, 4>');
    await resolver.declaredType('M4');
    await resolver.resolveTypeText('ns::data_t');
    assert.strictEqual(commands.length, count, 'repeated expansion must use the type cache');
    console.log('C++ quoting, class classification, pointer/enum layouts and cache checks passed.');
}

async function realChecks(gdb, elf) {
    // Captured with the user's ARM GDB/ELF in both language modes. Keeping the
    // output also makes this regression runnable without a local ARM toolchain.
    const recorded = require('./fixtures/live-memory/cpp-arm-queries.json');
    const types = [
        'Eigen::internal::plain_array<double, 16, 0, 16>',
        'arm_kinematics::input_t<4>::JointVector',
        'Eigen::Matrix<double, 4, 4, 0, 4, 4>'
    ];
    for (const language of ['c', 'c++']) {
        const commands = [];
        const consoleQuery = (command) => {
            commands.push(command);
            if (!gdb || !elf) {
                assert(command in recorded[language], `Unexpected real-ELF query: ${command}`);
                return recorded[language][command];
            }
            const result = spawnSync(gdb, ['--batch', '-nx', '-ex', 'set pagination off',
                '-ex', `file "${elf.replace(/\\/g, '/')}"`, '-ex', `set language ${language}`, '-ex', command],
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
            if (result.error || result.status !== 0 || result.stderr.trim()) {
                throw result.error || new Error(`${command}: ${result.stderr}`);
            }
            return result.stdout;
        };
        const resolver = new TypeResolver({ console: async (command) => consoleQuery(command),
            evaluate: async () => { throw new Error('Classification must not evaluate target expressions'); } });
        for (const type of types) {
            assert.strictEqual(await resolver.classifyTypeText(type), 'struct', `${language}: ${type}`);
        }
        const { parseMatrixShape } = require('../out/src/live-matrix');
        const matrix = parseMatrixShape(await resolver.declaredType('M4'));
        assert.deepStrictEqual([matrix.rows, matrix.columns], [4, 4], `${language}: nested M4 typedef must resolve to a 4x4 matrix`);
        assert(/array\[16\]/.test(consoleQuery(`ptype /o ${gdbTypeName(types[0])}`)));
        const count = commands.length;
        for (const type of types) {
            await resolver.classifyTypeText(type);
        }
        assert.strictEqual(commands.length, count);
        console.log(`Actual ARM ELF: Eigen and JointVector queries passed in ${language} mode without GDB errors.`);
    }
}

(async () => {
    await mockedChecks();
    await realChecks(process.argv[2], process.argv[3]);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
