// Run after npm run test-compile. No target or debugger is required.
const assert = require('assert');
const { LiveWatchWriter, validateLiveValue, isLiveStoragePath } = require('../out/src/backend/live-watch-write');
const { writableDataRegions } = require('../out/src/backend/live-memory-plan');

const scalar = (kind, byteSize, extras = {}) => ({ kind, byteSize, typeName: kind, ...extras });
assert.strictEqual(validateLiveValue('0009', scalar('unsigned', 1)), '9');
assert.strictEqual(validateLiveValue('-0x80', scalar('signed', 1)), '-128');
assert.strictEqual(validateLiveValue('18446744073709551615', scalar('unsigned', 8)), '18446744073709551615');
assert.strictEqual(validateLiveValue('true', scalar('bool', 1)), 'true');
assert.strictEqual(validateLiveValue('PID_ANGLE', scalar('enum', 1, { enumValues: new Map([['1', 'PID_ANGLE']]) })), 'PID_ANGLE');
assert.strictEqual(validateLiveValue('2.5e-3', scalar('float', 4)), '2.5e-3');
assert.strictEqual(validateLiveValue('010', scalar('float', 4)), '010.0', 'float input must not become an octal integer');
for (const input of ['256', '-1', 'fn()', 'x=1', '1\n-gdb-exit', '1; reset']) {
    assert.throws(() => validateLiveValue(input, scalar('unsigned', 1)));
}
for (const input of ['nan', 'inf', '1e40', '1e999', 'pid.kp + 1']) {
    assert.throws(() => validateLiveValue(input, scalar('float', 4)));
}
for (const path of ['pid.kp', '\'src/control.c\'::pid.kp', 'chassis.motors[3]->ctrl.kp', '*((float *)0x20000000)']) {
    assert(isLiveStoragePath(path), path);
}
for (const path of ['pid.kp++', 'arr[i++]', 'get_pid().kp', 'pid.kp=2', 'arr[foo()]', '*(get_ptr())', 'pid\n;quit']) {
    assert(!isLiveStoragePath(path), path);
}
const sections = '[1] 0x20000000->0x20000100 at 0x1000: .data ALLOC LOAD DATA\n'
    + '[2] 0x08000000->0x08000100 at 0x2000: .rodata ALLOC READONLY DATA\n'
    + '[3] 0x08000100->0x08000200 at 0x3000: .text ALLOC READONLY CODE\n';
assert.deepStrictEqual(writableDataRegions(sections), [{ start: 0x20000000, end: 0x20000100 }]);

function target(options = {}) {
    let memory = '1.25';
    let assigned = 0;
    const commands = [];
    const result = (values) => ({ result: (key) => values[key] });
    const mi = {
        async sendCommand(command) {
            commands.push(command);
            if (command.startsWith('var-show-attributes')) { return result({ attr: options.readonly ? 'noneditable' : 'editable' }); }
            if (command.startsWith('var-evaluate-expression')) { return result({ value: memory }); }
            return result({});
        },
        async varInfoPathExpression() { return options.path || 'pid.kp'; },
        async varInfoType() { return 'float'; },
        async sendCliCommand(command) {
            commands.push(command);
            return command.startsWith('whatis') ? `type = ${options.const ? 'const float' : 'float'}` : sections;
        },
        async evaluateNumber(expression) {
            commands.push(expression);
            return expression.startsWith('sizeof') ? '4' : options.address || '0x20000004';
        },
        async varCreate(_parent, expression, name) { commands.push(`create ${name} ${expression}`); },
        async varAssign(name, value) {
            commands.push(`assign ${name} ${value}`);
            assigned++;
            if (options.writeFails) { throw new Error('probe cannot write while running'); }
            memory = value;
            return result({ value });
        },
        async varUpdate(name) {
            commands.push(`update ${name}`);
            if (options.readFails) { throw new Error('probe disconnected'); }
            if (options.feedback) { memory = '123'; }
        }
    };
    const writer = new LiveWatchWriter(mi, { resolveTypeText: async () => scalar('float', 4) },
        () => !options.terminated);
    return {
        writer, commands,
        get memory() { return memory; },
        get assigned() { return assigned; }
    };
}

(async () => {
    const ram = target();
    assert.deepStrictEqual(await ram.writer.write('watch_pid.kp', '3.25'), {
        value: '3.25', appliedValue: '3.25', overwritten: false
    });
    assert.strictEqual(ram.memory, '3.25', 'write reaches real target storage');
    assert.strictEqual(ram.assigned, 1, 'one write, no forcing or replay');
    assert(ram.commands.some((command) => command.includes('*(float *)0x20000004')));
    assert(ram.commands.includes('var-delete live_write_1'));
    assert.strictEqual(target().memory, '1.25', 'a new session starts with target initialization');
    const feedback = target({ feedback: true });
    assert.strictEqual((await feedback.writer.write('watch_pid.feedback', '9')).overwritten, true);
    assert.strictEqual(feedback.memory, '123', 'firmware continues owning feedback');
    assert.strictEqual(feedback.assigned, 1);
    for (const options of [{ readonly: true }, { const: true }, { address: '0x08000000' },
        { address: '0x40000000' }, { address: '0x200000ff' }, { address: '0x0' },
        { path: 'get_pid().kp' }, { terminated: true }]) {
        const blocked = target(options);
        await assert.rejects(blocked.writer.write('watch_pid.kp', '3'));
        assert.strictEqual(blocked.assigned, 0, JSON.stringify(options));
    }
    for (const options of [{ writeFails: true }, { readFails: true }]) {
        const failed = target(options);
        await assert.rejects(failed.writer.write('watch_pid.kp', '3'));
        assert(failed.commands.includes('var-delete live_write_1'), 'cleanup on failure');
    }
    console.log('Live Watch runtime write, readonly/storage checks, readback and session checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
