// Run after npm run test-compile: node test/live-watch-write-real.test.js
// Uses a local native GDB inferior, not an attached MCU. Requires ptrace.
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
function stub() {
    return new Proxy(function () {}, { get: () => stub(), apply: () => stub(), construct: () => stub() });
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? stub() : originalLoad.call(this, request, parent, isMain);
};
const { MI2 } = require('../out/src/backend/mi2/mi2');
const { TypeResolver } = require('../out/src/backend/live-memory-types');
const { LiveWatchWriter } = require('../out/src/backend/live-watch-write');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-watch-write-'));
const source = path.join(directory, 'pid.c');
const elf = path.join(directory, 'pid');
fs.writeFileSync(source, '#include <stdio.h>\n'
    + 'typedef float fp32;\n'
    + 'typedef enum {PID_LINEAR, PID_ANGLE} Mode;\n'
    + 'typedef struct {fp32 kp; float ki; unsigned char limit; const int readonly; Mode mode;} Pid;\n'
    + 'Pid pid={1.25f,2.0f,10,9,PID_LINEAR};\n'
    + 'const Pid readonly_pid={1.0f,0.0f,10,9,PID_LINEAR};\n'
    + 'int main(void){printf("effect=%.2f\\n",pid.kp*10.0f+pid.ki);return 0;}\n');
const built = spawnSync('gcc', ['-g', '-O0', '-no-pie', source, '-o', elf], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, built.stderr);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = [hash(source), hash(elf)];
const mi = new MI2(process.env.LIVE_WRITE_GDB || 'gdb', ['-q', '-nx', '--interpreter=mi2', elf], true);
let output = '';
mi.on('msg', (_type, text) => {
    output += text;
});
function event(name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}: ${output}`)), 10000);
        mi.once(name, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}
(async () => {
    try {
        await mi.start(directory, ['break-insert main']);
        let stopped = event('breakpoint');
        await mi.sendCommand('exec-run');
        await stopped;
        const resolver = new TypeResolver({ console: (cmd) => mi.sendCliCommand(cmd), evaluate: (expr) => mi.evaluateNumber(expr) });
        const writer = new LiveWatchWriter(mi, resolver, () => true);
        await mi.varCreate(0, 'pid', 'pid_watch', '@');
        await mi.varListChildren(1, 'pid_watch');
        const result = await writer.write('pid_watch.kp', '3.25');
        assert.strictEqual(Number(result.value), 3.25);
        assert.strictEqual(Number(await mi.evaluateNumber('pid.kp')), 3.25);
        assert.strictEqual(Number(await mi.evaluateNumber('pid.ki')), 2, 'neighbor remains unchanged');
        await writer.write('pid_watch.limit', '0xff');
        assert.strictEqual(await mi.evaluateNumber('(int)pid.limit'), '255');
        await assert.rejects(writer.write('pid_watch.limit', '256'), /范围/);
        await assert.rejects(writer.write('pid_watch.readonly', '20'), /只读|不可赋值/);
        await mi.varCreate(0, 'readonly_pid.kp', 'readonly_watch', '@');
        await assert.rejects(writer.write('readonly_watch', '20'), /只读|RAM/);
        await writer.write('pid_watch.mode', 'PID_ANGLE');
        assert.strictEqual(await mi.evaluateNumber('pid.mode'), 'PID_ANGLE');
        const exited = event('exited-normally');
        await mi.sendCommand('exec-continue');
        await exited;
        assert(output.includes('effect=34.50'), output);
        stopped = event('breakpoint');
        await mi.sendCommand('exec-run');
        await stopped;
        assert.strictEqual(Number(await mi.evaluateNumber('pid.kp')), 1.25, 'new run uses firmware initial value');
        assert.deepStrictEqual([hash(source), hash(elf)], originals, 'source and executable never changed');
        console.log('Real GDB: typed struct member assignment affects execution; next run resets; source/ELF unchanged');
    } finally {
        await mi.sendCommand('gdb-exit');
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
