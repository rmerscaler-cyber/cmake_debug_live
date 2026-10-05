/*
 * Engine integration checks with a fake MI transport and memory model.
 * Run with:  npm run test-compile && node test/live-memory-engine.test.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

/* ---- minimal vscode stub so backend modules can be required outside VS Code ---- */
function makeStub() {
    return new Proxy(function () { }, {
        get: (target, prop) => {
            if (prop === 'toString') { return () => '[vscode-stub]'; }
            if (prop === Symbol.toPrimitive) { return () => '[vscode-stub]'; }
            return makeStub();
        },
        apply: () => makeStub(),
        construct: () => makeStub()
    });
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return makeStub(); }
    return originalLoad.call(this, request, parent, isMain);
};

const { VariableObject, syntacticTypeKind } = require('../out/src/backend/backend.js');
const { LiveMemoryEngine, resolveMemberPath } = require('../out/src/live-memory-engine.js');
const { mergeRanges } = require('../out/src/backend/live-memory-plan.js');
const { decodeScalarValue, formatFloat32, formatFloat64 } = require('../out/src/backend/live-memory-decode.js');
const { assembleFragments, fragmentsFromMi } = require('../out/src/backend/live-memory-reader.js');
const { parseMI } = require('../out/src/backend/mi_parse.js');
const { TypeResolver } = require('../out/src/backend/live-memory-types.js');

let failures = 0;
let checks = 0;
function check(name, fn) {
    checks++;
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`);
    }
}

/* ------------------------------------------------------------------ */
/* pure plan / decode / reader checks                                  */
/* ------------------------------------------------------------------ */
console.log('== plan / decode / reader ==');
check('array and function pointer kinds win over typedef resolution', () => {
    assert.strictEqual(syntacticTypeKind('motor_handle_t [4]'), 'array');
    assert.strictEqual(syntacticTypeKind('motor_handle_t'), 'typedef');
    assert.strictEqual(syntacticTypeKind('const motor_driver_ops_t *'), 'pointer');
    assert.strictEqual(syntacticTypeKind('void (*)(int)'), 'function-pointer');
});
check('mergeRanges merges same-region gap and splits at block limit', () => {
    const regions = [{ start: 0x20000000, end: 0x20010000 }];
    const merged = mergeRanges([
        { address: 0x20000000, length: 16 },
        { address: 0x20000030, length: 16 },
        { address: 0x20000100, length: 16 }
    ], { maxBlockBytes: 64, maxGapBytes: 64, regions });
    assert.strictEqual(merged.rejected.length, 0);
    assert.strictEqual(merged.blocks.length, 2);
    assert.strictEqual(merged.blocks[0].length, 64);
    assert.strictEqual(merged.blocks[1].address, 0x20000100);
});
check('mergeRanges rejects ranges outside whitelist', () => {
    const merged = mergeRanges([{ address: 0x40000000, length: 4 }], {
        maxBlockBytes: 64, maxGapBytes: 0, regions: [{ start: 0x20000000, end: 0x20010000 }]
    });
    assert.strictEqual(merged.blocks.length, 0);
    assert.strictEqual(merged.rejected.length, 1);
});
check('decode int/float/pointer/enum from buffer', () => {
    const buffer = Buffer.alloc(16);
    buffer.writeInt16LE(-3, 0);
    buffer.writeUInt16LE(7, 2);
    buffer.writeFloatLE(1.5, 4);
    buffer.writeUInt32LE(0x20000080, 8);
    buffer.writeUInt8(1, 12);
    assert.strictEqual(decodeScalarValue(buffer, 0, { kind: 'signed', byteSize: 2, typeName: 'int16_t' }, 'little'), '-3');
    assert.strictEqual(decodeScalarValue(buffer, 2, { kind: 'unsigned', byteSize: 2, typeName: 'uint16_t' }, 'little'), '7');
    assert.strictEqual(decodeScalarValue(buffer, 4, { kind: 'float', byteSize: 4, typeName: 'fp32' }, 'little'), '1.5');
    assert.strictEqual(decodeScalarValue(buffer, 8, { kind: 'pointer', byteSize: 4, typeName: 'void *' }, 'little'), '0x20000080');
});
check('decode 1-byte enum and unknown enum value', () => {
    const buffer = Buffer.from([0x02, 0x09]);
    const type = { kind: 'enum', byteSize: 1, signed: false, enumValues: new Map([['2', 'CHASSIS_SPIN']]), typeName: 'e' };
    assert.strictEqual(decodeScalarValue(buffer, 0, type, 'little'), 'CHASSIS_SPIN');
    assert.strictEqual(decodeScalarValue(buffer, 1, type, 'little'), '9');
});
check('decode 64-bit integer without precision loss', () => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(0xffffffff, 0);
    buffer.writeUInt32LE(0xffffffff, 4);
    assert.strictEqual(decodeScalarValue(buffer, 0, { kind: 'unsigned', byteSize: 8, typeName: 'uint64_t' }, 'little'), '18446744073709551615');
});
check('float formatters follow GDB style closely', () => {
    assert.strictEqual(formatFloat32(Math.fround(0.1)), '0.100000001');
    assert.strictEqual(formatFloat32(16777216), '16777216');
    assert.strictEqual(formatFloat32(Math.fround(1.401298464324817e-45)), '1.40129846e-45');
    assert.strictEqual(formatFloat64(1e10), '10000000000');
    assert.strictEqual(formatFloat64(1e20), '1e+20');
    assert.strictEqual(formatFloat32(Number.NaN), 'nan');
});
check('assembleFragments rejects holes and short data', () => {
    assert.throws(() => assembleFragments([
        { begin: 0x100, end: 0x104, offset: 0, contents: '01020304' },
        { begin: 0x108, end: 0x10c, offset: 0, contents: '05060708' }
    ], 0x100, 12), /hole/);
    assert.throws(() => assembleFragments([
        { begin: 0x100, end: 0x104, offset: 0, contents: '0102' }
    ], 0x100, 4), /length mismatch/);
    const ok = assembleFragments([{ begin: 0x100, end: 0x104, offset: 0, contents: '01020304' }], 0x100, 4);
    assert.strictEqual(ok.data.toString('hex'), '01020304');
});
check('fragmentsFromMi parses MI memory results', () => {
    const node = parseMI('^done,memory=[{begin="0x20000000",offset="0x00000000",end="0x20000004",contents="01020304"}]\n');
    const fragments = fragmentsFromMi(node.result('memory'));
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].begin, 0x20000000);
});

console.log('== resolveMemberPath ==');
check('multi-dimensional array strides', () => {
    const root = {
        kind: 'struct', byteSize: 96, typeName: 't', members: [{
            name: 'power_k', byteOffset: 0, byteSize: 96, arrayDims: [4, 6],
            type: { kind: 'float', byteSize: 4, typeName: 'fp32' }
        }]
    };
    assert.strictEqual(resolveMemberPath(root, ['power_k', '2', '3']).offset, 2 * 24 + 3 * 4);
    assert.strictEqual(resolveMemberPath(root, ['power_k', '0', '0']).offset, 0);
    assert.strictEqual(resolveMemberPath(root, ['power_k', '3', '5']).offset, 3 * 24 + 5 * 4);
});

/* ------------------------------------------------------------------ */
/* engine with fake transport                                          */
/* ------------------------------------------------------------------ */
function buildVariable(handle, name, type, numchild = 0, value = '') {
    const node = [
        ['name', name], ['exp', name], ['numchild', String(numchild)],
        ['type', type], ['value', value]
    ];
    return new VariableObject(0, node);
}

function makeFakeTransport(sections, types, addresses, memory, decimalAddresses = false, whatisMap = {}) {
    return {
        calls: [],
        typeQueries: [],
        async sendCliCommand(command) {
            if (command === 'maintenance info sections') { return sections; }
            const whatis = /^whatis \/r (.+)$/.exec(command);
            if (whatis) { return whatisMap[whatis[1]] || ''; }
            const match = /^ptype \/o (.+)$/.exec(command);
            if (match) {
                this.typeQueries.push(match[1]);
                return types[match[1]] || `No symbol "${match[1]}" in current context.`;
            }
            return '';
        },
        async evaluateNumber(expression) {
            if (expression === 'sizeof(void *)') { return '4'; }
            if (expression === '((char)-1) < 0') { return '0'; }
            const address = /^\(unsigned long\)&\((.+)\)$/.exec(expression);
            if (address) {
                if (addresses[address[1]] === undefined) { return decimalAddresses ? '0' : '0x0'; }
                return decimalAddresses
                    ? String(addresses[address[1]])
                    : `0x${addresses[address[1]].toString(16)}`;
            }
            const size = /^sizeof\((.+)\)$/.exec(expression);
            if (size) { return '4'; }
            return '';
        },
        async varInfoPathExpression(name) { return name; },
        async varInfoType(name) { return types[name] || name; },
        async readMemoryRange(address, length) {
            this.calls.push({ address, length });
            const data = Buffer.alloc(length);
            for (let i = 0; i < length; i++) {
                data[i] = memory.get(address + i) || 0;
            }
            return { address, data, fragments: 1 };
        },
        async sendCommand(command) { throw new Error(`unexpected MI command: ${command}`); }
    };
}

function poke(memory, address, buffer) {
    for (let i = 0; i < buffer.length; i++) {
        memory.set(address + i, buffer[i]);
    }
}

const rootTypeText = `type = struct {
/*      0      |       2 */    int16_t a;
/*      2      |       2 */    int16_t b;
/*      4      |       4 */    fp32 f;
/*      8      |       4 */    void *ptr;
/*     12      |       1 */    uint8_t flag;
/* XXX  3-byte padding   */

                               /* total size (bytes):   16 */
                             }`;
const targetTypeText = `type = struct {
/*      0      |       4 */    fp32 x;
/*      4      |       4 */    fp32 y;

                               /* total size (bytes):    8 */
                             }`;

async function runEngineScenario(options2 = {}) {
    const decimalAddresses = Boolean(options2.decimalAddresses);
    const noPathExpression = Boolean(options2.noPathExpression);
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const types = {
        'int16_t': 'type = short',
        'uint8_t': 'type = unsigned char',
        'fp32': 'type = float',
        'test_root_t': rootTypeText,
        'test_target_t': targetTypeText
    };
    const addresses = { root1: 0x20000000 };
    const paths = { root1: 'root1' };
    const memory = new Map();
    poke(memory, 0x20000000, Buffer.from([0xfd, 0xff, 0x07, 0x00, 0x00, 0x00, 0xc0, 0x3f, 0x80, 0x00, 0x00, 0x20, 0x01, 0x00, 0x00, 0x00]));
    poke(memory, 0x20000080, Buffer.concat([Buffer.from([0x00, 0x00, 0x80, 0x3e]) /* 0.25 */, Buffer.from([0x00, 0x00, 0x20, 0xc0])]));
    const transport = makeFakeTransport(sections, types, addresses, memory, decimalAddresses);
    transport.varInfoPathExpression = async (name) => (noPathExpression ? undefined : (paths[name] || name));

    const variables = new Map();
    const names = new Map();
    let nextHandle = 1;
    const add = (name, type, numchild, value) => {
        const variable = buildVariable(nextHandle, name, type, numchild, value);
        variables.set(nextHandle, variable);
        names.set(name, nextHandle);
        nextHandle++;
        return variable;
    };
    add('root1', 'test_root_t', 5, '{...}');
    add('r_a', 'int16_t', 0, '0');
    add('r_b', 'int16_t', 0, '0');
    add('r_f', 'fp32', 0, '0');
    add('r_ptr', 'void *', 0, '0x0');
    add('d1', 'test_target_t', 2, '{...}');
    add('d_x', 'fp32', 0, '0');
    add('d_y', 'fp32', 0, '0');
    const parents = new Map([
        ['r_a', { parent: 'root1', key: 'a' }],
        ['r_b', { parent: 'root1', key: 'b' }],
        ['r_f', { parent: 'root1', key: 'f' }],
        ['r_ptr', { parent: 'root1', key: 'ptr' }],
        ['d_x', { parent: 'd1', key: 'x' }],
        ['d_y', { parent: 'd1', key: 'y' }]
    ]);
    const store = {
        variableHandlesReverse: names,
        variableHandles: { get: (handle) => variables.get(handle) },
        variableParents: parents
    };
    const options = { mode: 'auto', maxBlockBytes: 1024, mergeGapBytes: 256, maxDepth: 8, extraRamRegions: [] };
    const engine = new LiveMemoryEngine(store, transport, () => options);
    engine.setSubscription(1, [
        { id: 'root1', kind: 'container' },
        { id: 'r_a', parent: 'root1', kind: 'container' },
        { id: 'r_b', parent: 'root1', kind: 'container' },
        { id: 'r_f', parent: 'root1', kind: 'container' },
        { id: 'r_ptr', parent: 'root1', kind: 'container' },
        { id: 'd1', parent: 'r_ptr', kind: 'deref', pointer: 'r_ptr' },
        { id: 'd_x', parent: 'd1', kind: 'container' },
        { id: 'd_y', parent: 'd1', kind: 'container' }
    ]);
    const result = await engine.sample();
    return { result, engine, transport, memory, poke };
}

async function engineChecks() {
    console.log('== engine (fake transport) ==');
    const { result, engine, transport, memory } = await runEngineScenario();
    const valueOf = (id) => result.values.find((value) => value.id === id);
    check('engine prepares and samples root + pointer target', () => {
        assert.strictEqual(result.stats.phase, 'sample', JSON.stringify(result.values));
        assert.strictEqual(valueOf('r_a').value, '-3');
        assert.strictEqual(valueOf('r_b').value, '7');
        assert.strictEqual(valueOf('r_f').value, '1.5');
        assert.strictEqual(valueOf('r_ptr').value, '0x20000080');
        assert.strictEqual(valueOf('d_x').value, '0.25');
        assert.strictEqual(valueOf('d_y').value, '-2.5');
    });
    check('engine uses two block reads for the two objects', () => {
        assert.strictEqual(result.stats.memoryReadCommands, 2);
        assert.strictEqual(result.stats.blockCount, 2);
        assert.strictEqual(transport.calls.length, 2);
    });
    const queriesBefore = transport.typeQueries.length;
    const second = await engine.sample();
    check('engine does not query paths/sizes per field on the steady path', () => {
        assert.strictEqual(second.stats.phase, 'sample');
        assert.strictEqual(transport.typeQueries.length, queriesBefore);
        assert.strictEqual(second.stats.memoryReadCommands, 2);
    });
    poke(memory, 0x20000008, Buffer.from([0x90, 0x00, 0x00, 0x20]));
    poke(memory, 0x20000090, Buffer.from([0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0xc0]));
    const moved = await engine.sample();
    poke(memory, 0x20000008, Buffer.from([0x00, 0x00, 0x00, 0x00]));
    const nul = await engine.sample();
    check('pointer change is re-read and null pointer marks target unavailable', () => {
        assert.strictEqual(moved.values.find((value) => value.id === 'd_x').value, '2');
        assert.strictEqual(nul.values.find((value) => value.id === 'd_x').status, 'unavailable');
    });

    // GDB prints `(unsigned long)&(...)` in the configured output radix; a
    // decimal radix once broke every root address and forced full fallback.
    const decimal = await runEngineScenario({ decimalAddresses: true });
    check('decimal address output still resolves and samples in bulk', () => {
        assert.strictEqual(decimal.result.stats.phase, 'sample');
        assert.strictEqual(decimal.result.stats.fallbackFieldCount, 0);
        assert.strictEqual(decimal.result.stats.memoryReadCommands, 2);
        assert.strictEqual(decimal.result.values.find((value) => value.id === 'r_f').value, '1.5');
    });

    const noPath = await runEngineScenario({ noPathExpression: true });
    check('unsupported plan hands the frame back to legacy instead of per-field fallback', () => {
        assert.strictEqual(noPath.result.useLegacy, true);
        assert.strictEqual(noPath.transport.calls.length, 0);
        assert(noPath.result.stats.errors.some((error) => error.includes('逐字段模式')), JSON.stringify(noPath.result.stats.errors));
    });
}

/* ------------------------------------------------------------------ */
/* field-count independence                                            */
/* ------------------------------------------------------------------ */
async function fieldCountChecks() {
    console.log('== field-count independence ==');
    const memberLines = [];
    for (let i = 0; i < 100; i++) {
        memberLines.push(`/* ${String(i * 4).padStart(6)}      |       4 */    int32_t m${i};`);
    }
    const bigType = `type = struct {\n${memberLines.join('\n')}\n\n`
        + '                               /* total size (bytes):  400 */\n                             }';
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const types = { 'int32_t': 'type = int', 'big_t': bigType };
    const addresses = { big1: 0x20000000 };
    const memory = new Map();

    async function run(count) {
        const transport = makeFakeTransport(sections, types, addresses, memory);
        const variables = new Map();
        const names = new Map();
        let nextHandle = 1;
        const node = [['name', 'big1'], ['exp', 'big1'], ['numchild', String(count + 1)], ['type', 'big_t'], ['value', '{...}']];
        variables.set(nextHandle, new VariableObject(0, node));
        names.set('big1', nextHandle++);
        const parents = new Map();
        const subscription = [{ id: 'big1', kind: 'container' }];
        for (let i = 0; i < count; i++) {
            const name = `f${i}`;
            const childNode = [['name', name], ['exp', name], ['numchild', '0'], ['type', 'int32_t'], ['value', '0']];
            variables.set(nextHandle, new VariableObject(0, childNode));
            names.set(name, nextHandle);
            nextHandle++;
            parents.set(name, { parent: 'big1', key: `m${i}` });
            subscription.push({ id: name, parent: 'big1', kind: 'container' });
        }
        const store = {
            variableHandlesReverse: names,
            variableHandles: { get: (handle) => variables.get(handle) },
            variableParents: parents
        };
        const options = { mode: 'auto', maxBlockBytes: 1024, mergeGapBytes: 256, maxDepth: 8, extraRamRegions: [] };
        const engine = new LiveMemoryEngine(store, transport, () => options);
        engine.setSubscription(1, subscription);
        const result = await engine.sample();
        return { result, commands: transport.calls.length };
    }

    const ten = await run(10);
    const hundred = await run(100);
    check('10 vs 100 fields in one object keep the same command count', () => {
        assert.strictEqual(ten.result.stats.phase, 'sample');
        assert.strictEqual(hundred.result.stats.phase, 'sample');
        assert.strictEqual(ten.commands, 1);
        assert.strictEqual(hundred.commands, 1);
        assert.strictEqual(hundred.result.stats.successfulFieldCount, 100);
    });
}

/* ------------------------------------------------------------------ */
/* regressions from full structure subscriptions and wireless probes    */
/* ------------------------------------------------------------------ */
async function nestedContainerChecks() {
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const innerType = 'type = struct {\n/*      0      |       4 */    int32_t a;\n'
        + '/* total size (bytes): 4 */\n}';
    const rootType = 'type = struct {\n/*      0      |       4 */    inner_t command;\n'
        + '/*      4      |       4 */    int32_t tail;\n/* total size (bytes): 8 */\n}';
    const memory = new Map();
    poke(memory, 0x20000000, Buffer.from([42, 0, 0, 0, 73, 0, 0, 0]));
    const transport = makeFakeTransport(sections, {
        inner_t: innerType, root_t: rootType, int32_t: 'type = int'
    }, { root: 0x20000000 }, memory);
    const variables = new Map();
    const names = new Map();
    const add = (name, type, count, value) => {
        const id = names.size + 1;
        names.set(name, id);
        variables.set(id, buildVariable(id, name, type, count, value));
    };
    add('root', 'root_t', 2, '{command = {...}, tail = 73}');
    add('command', 'inner_t', 1, '{a = 42}');
    add('command_a', 'int32_t', 0, '0');
    add('tail', 'int32_t', 0, '0');
    const parents = new Map([
        ['command', { parent: 'root', key: 'command' }],
        ['command_a', { parent: 'command', key: 'a' }],
        ['tail', { parent: 'root', key: 'tail' }]
    ]);
    const store = { variableHandlesReverse: names, variableHandles: { get: (id) => variables.get(id) }, variableParents: parents };
    const options = { mode: 'auto', maxBlockBytes: 1024, mergeGapBytes: 256, maxDepth: 8, extraRamRegions: [] };
    const engine = new LiveMemoryEngine(store, transport, () => options);
    engine.setSubscription(1, [
        { id: 'root', kind: 'container' },
        { id: 'command', parent: 'root', kind: 'container' },
        { id: 'command_a', parent: 'command', kind: 'container' },
        { id: 'tail', parent: 'root', kind: 'container' }
    ]);
    const frame = await engine.sample();
    check('nested struct containers are decoded from one host memory block without GDB fallback', () => {
        assert.strictEqual(frame.stats.phase, 'sample');
        assert.strictEqual(frame.stats.fallbackFieldCount, 0);
        assert.strictEqual(frame.stats.memoryReadCommands, 1);
        assert.strictEqual(frame.values.find((value) => value.id === 'command_a').value, '42');
        assert.strictEqual(frame.values.find((value) => value.id === 'tail').value, '73');
    });
}

async function splitAndPrepareChecks() {
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const largeType = 'type = struct {\n/*    300      |       4 */    int32_t value;\n'
        + '/* total size (bytes): 404 */\n}';
    const memory = new Map();
    poke(memory, 0x2000012c, Buffer.from([73, 0, 0, 0]));
    const types = { large_t: largeType, int32_t: 'type = int' };
    const transport = makeFakeTransport(sections, types, { root: 0x20000000 }, memory);
    const variables = new Map([
        [1, buildVariable(1, 'root', 'large_t', 1, '{...}')],
        [2, buildVariable(2, 'value', 'int32_t', 0, '0')]
    ]);
    const store = {
        variableHandlesReverse: new Map([['root', 1], ['value', 2]]),
        variableHandles: { get: (id) => variables.get(id) },
        variableParents: new Map([['value', { parent: 'root', key: 'value' }]])
    };
    const options = { mode: 'auto', maxBlockBytes: 256, mergeGapBytes: 0, maxDepth: 8, extraRamRegions: [] };
    const engine = new LiveMemoryEngine(store, transport, () => options);
    engine.setSubscription(1, [{ id: 'root', kind: 'container' }, { id: 'value', parent: 'root', kind: 'container' }]);
    const frame = await engine.sample();
    check('a sparse field in a large object reads only its four bytes', () => {
        assert.strictEqual(frame.stats.memoryReadCommands, 1);
        assert.strictEqual(frame.stats.receivedBytes, 4);
        assert.deepStrictEqual(transport.calls, [{ address: 0x2000012c, length: 4 }]);
        assert.strictEqual(frame.values.find((item) => item.id === 'value').value, '73');
    });

    const delayed = makeFakeTransport(sections, types, { first: 0x20000000, second: 0x20001000 }, memory);
    const sendCli = delayed.sendCliCommand.bind(delayed);
    delayed.sendCliCommand = async (line) => {
        if (line === 'ptype /o large_t') { await new Promise((resolve) => setTimeout(resolve, 220)); }
        return sendCli(line);
    };
    const roots = new Map([
        [1, buildVariable(1, 'first', 'large_t', 1, '{...}')],
        [2, buildVariable(2, 'second', 'large_t', 1, '{...}')],
        [3, buildVariable(3, 'first_value', 'int32_t', 0, '0')],
        [4, buildVariable(4, 'second_value', 'int32_t', 0, '0')]
    ]);
    const delayedStore = {
        variableHandlesReverse: new Map([['first', 1], ['second', 2], ['first_value', 3], ['second_value', 4]]),
        variableHandles: { get: (id) => roots.get(id) },
        variableParents: new Map([
            ['first_value', { parent: 'first', key: 'value' }],
            ['second_value', { parent: 'second', key: 'value' }]
        ])
    };
    const delayedEngine = new LiveMemoryEngine(delayedStore, delayed, () => options);
    delayedEngine.setSubscription(1, [
        { id: 'first', kind: 'container' }, { id: 'first_value', parent: 'first', kind: 'container' },
        { id: 'second', kind: 'container' }, { id: 'second_value', parent: 'second', kind: 'container' }
    ]);
    const preparing = await delayedEngine.sample();
    const complete = await delayedEngine.sample();
    check('a preparation step over 200 ms resumes before either owner is sampled', () => {
        assert.strictEqual(preparing.stats.phase, 'prepare');
        assert.strictEqual(complete.stats.phase, 'sample');
        assert.strictEqual(complete.stats.memoryReadCommands, 2);
    });
}

/* ------------------------------------------------------------------ */
/* typedef pointer expansion regression (H7 motor_handle_t shape)      */
/* ------------------------------------------------------------------ */
async function typedefPointerChecks() {
    console.log('== typedef pointer regression ==');
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const targetTypeText = `type = struct {
/*      0      |       4 */    fp32 x;
/*      4      |       4 */    fp32 y;

                               /* total size (bytes):    8 */
                             }`;
    const types = {
        'int16_t': 'type = short',
        'uint8_t': 'type = unsigned char',
        'fp32': 'type = float',
        // GDB's `ptype /o handle_t` expands the typedef-to-pointer into the
        // pointee struct; this used to make the member look like an embedded
        // aggregate and shifted the whole plan to the pointer slot.
        'handle_t': targetTypeText,
        'trap_root_t': `type = struct {
/*      0      |       2 */    int16_t a;
/* XXX  2-byte hole      */
/*      4      |       4 */    handle_t h;

                               /* total size (bytes):    8 */
                             }`,
        'test_target_t': targetTypeText
    };
    const whatisMap = { 'handle_t': 'type = test_target_t *' };
    const addresses = { root1: 0x20000000 };
    const memory = new Map();
    poke(memory, 0x20000000, Buffer.from([0xfd, 0xff, 0x00, 0x00, 0x80, 0x00, 0x00, 0x20]));
    poke(memory, 0x20000080, Buffer.concat([Buffer.from([0x00, 0x00, 0x80, 0x3e]), Buffer.from([0x00, 0x00, 0x20, 0xc0])]));

    const transport = makeFakeTransport(sections, types, addresses, memory, false, whatisMap);
    const variables = new Map();
    const names = new Map();
    let nextHandle = 1;
    const add = (name, type, numchild) => {
        variables.set(nextHandle, buildVariable(nextHandle, name, type, numchild, '{...}'));
        names.set(name, nextHandle);
        nextHandle++;
    };
    add('root1', 'trap_root_t', 2);
    add('r_a', 'int16_t', 0);
    add('r_h', 'handle_t', 0);
    add('d1', 'test_target_t', 2);
    add('d_x', 'fp32', 0);
    add('d_y', 'fp32', 0);
    const parents = new Map([
        ['r_a', { parent: 'root1', key: 'a' }],
        ['r_h', { parent: 'root1', key: 'h' }],
        ['d_x', { parent: 'd1', key: 'x' }],
        ['d_y', { parent: 'd1', key: 'y' }]
    ]);
    const store = {
        variableHandlesReverse: names,
        variableHandles: { get: (handle) => variables.get(handle) },
        variableParents: parents
    };
    const options = { mode: 'auto', maxBlockBytes: 1024, mergeGapBytes: 256, maxDepth: 8, extraRamRegions: [] };
    const engine = new LiveMemoryEngine(store, transport, () => options);
    engine.setSubscription(1, [
        { id: 'root1', kind: 'container' },
        { id: 'r_a', parent: 'root1', kind: 'container' },
        { id: 'r_h', parent: 'root1', kind: 'container' },
        { id: 'd1', parent: 'r_h', kind: 'deref', pointer: 'r_h' },
        { id: 'd_x', parent: 'd1', kind: 'container' },
        { id: 'd_y', parent: 'd1', kind: 'container' }
    ]);
    const result = await engine.sample();
    const valueOf = (id) => result.values.find((value) => value.id === id);
    check('typedef pointer stays a pointer and target is read at its value', () => {
        assert.strictEqual(result.stats.phase, 'sample', JSON.stringify(result.values));
        assert.strictEqual(valueOf('r_a').value, '-3');
        assert.strictEqual(valueOf('r_h').value, '0x20000080');
        assert.strictEqual(valueOf('d_x').value, '0.25');
        assert.strictEqual(valueOf('d_y').value, '-2.5');
        assert.strictEqual(result.stats.memoryReadCommands, 2);
    });
}

/* ------------------------------------------------------------------ */
/* pointer array element deref refresh (wheel_motor[i] shape)          */
/* ------------------------------------------------------------------ */
async function pointerArrayChecks() {
    console.log('== pointer array refresh ==');
    const sections = ' [11]     0x20000000->0x20010000 at 0x00028190: .bss ALLOC\n';
    const targetTypeText = `type = struct {
/*      0      |       4 */    fp32 x;
/*      4      |       4 */    fp32 y;

                               /* total size (bytes):    8 */
                             }`;
    const types = {
        'int32_t': 'type = int',
        'uint8_t': 'type = unsigned char',
        'fp32': 'type = float',
        'handle_t': targetTypeText,
        'arr_root_t': `type = struct {
/*      0      |       4 */    int32_t dummy;
/*      4      |       8 */    handle_t arr[2];

                               /* total size (bytes):   12 */
                             }`,
        'test_target_t': targetTypeText
    };
    const whatisMap = { 'handle_t': 'type = test_target_t *' };
    const addresses = { root1: 0x20000000 };
    const memory = new Map();
    // root: dummy=0, arr[0]=0x20000080, arr[1]=0x20000090
    poke(memory, 0x20000000, Buffer.from([0, 0, 0, 0, 0x80, 0x00, 0x00, 0x20, 0x90, 0x00, 0x00, 0x20]));
    poke(memory, 0x20000080, Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x00]));
    poke(memory, 0x20000090, Buffer.from([0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x10, 0x41]));

    const transport = makeFakeTransport(sections, types, addresses, memory, false, whatisMap);
    const variables = new Map();
    const names = new Map();
    let nextHandle = 1;
    const add = (name, type, numchild) => {
        variables.set(nextHandle, buildVariable(nextHandle, name, type, numchild, '{...}'));
        names.set(name, nextHandle);
        nextHandle++;
    };
    add('root1', 'arr_root_t', 4);
    add('r_dummy', 'int32_t', 0);
    add('r_arr', 'handle_t [2]', 2);
    add('e0', 'handle_t', 0);
    add('e1', 'handle_t', 0);
    add('d1', 'test_target_t', 2);
    add('d_x', 'fp32', 0);
    add('d_y', 'fp32', 0);
    const parents = new Map([
        ['r_dummy', { parent: 'root1', key: 'dummy' }],
        ['r_arr', { parent: 'root1', key: 'arr' }],
        ['e0', { parent: 'r_arr', key: '0' }],
        ['e1', { parent: 'r_arr', key: '1' }],
        ['d_x', { parent: 'd1', key: 'x' }],
        ['d_y', { parent: 'd1', key: 'y' }]
    ]);
    const store = {
        variableHandlesReverse: names,
        variableHandles: { get: (handle) => variables.get(handle) },
        variableParents: parents
    };
    const options = { mode: 'auto', maxBlockBytes: 2048, mergeGapBytes: 512, maxDepth: 8, extraRamRegions: [] };
    const engine = new LiveMemoryEngine(store, transport, () => options);
    engine.setSubscription(1, [
        { id: 'root1', kind: 'container' },
        { id: 'r_dummy', parent: 'root1', kind: 'container' },
        { id: 'r_arr', parent: 'root1', kind: 'container' },
        { id: 'e0', parent: 'r_arr', kind: 'container' },
        { id: 'e1', parent: 'r_arr', kind: 'container' },
        { id: 'd1', parent: 'e1', kind: 'deref', pointer: 'e1' },
        { id: 'd_x', parent: 'd1', kind: 'container' },
        { id: 'd_y', parent: 'd1', kind: 'container' }
    ]);
    const first = await engine.sample();
    const valueOf = (result, id) => result.values.find((value) => value.id === id);
    check('array element pointer resolves and target is decoded', () => {
        assert.strictEqual(first.stats.phase, 'sample', JSON.stringify(first.values));
        assert.strictEqual(valueOf(first, 'e1').value, '0x20000090');
        assert.strictEqual(valueOf(first, 'd_x').value, '2');
        assert.strictEqual(valueOf(first, 'd_y').value, '9');
        assert.strictEqual(first.stats.memoryReadCommands, 2);
    });
    // The MCU overwrites the target object in place; the pointer does not move.
    poke(memory, 0x20000090, Buffer.from([0x00, 0x00, 0x60, 0x40, 0x00, 0x00, 0x80, 0xbf]));
    const second = await engine.sample();
    check('in-place target updates are visible on the next frame', () => {
        assert.strictEqual(valueOf(second, 'd_x').value, '3.5');
        assert.strictEqual(valueOf(second, 'd_y').value, '-1');
        assert.strictEqual(second.stats.memoryReadCommands, 2);
    });
}

/* Actual F4 gimbal layout: unopened Kalman matrices must not block scalar sampling. */
async function largeGimbalChecks() {
    console.log('== F4 gimbal selective initialization ==');
    const queries = require('./fixtures/live-memory/f4-gimbal-queries.json');
    const aliasCommands = [];
    const aliasResolver = new TypeResolver({
        console: async (command) => {
            aliasCommands.push(command);
            if (command === 'whatis /r gimbal_control_t') { return 'type = gimbal_control'; }
            if (command === 'whatis /r gimbal_control') { return 'type = gimbal_control_t'; }
            return queries[command] || '';
        },
        evaluate: async () => '4'
    });
    const aliasLayout = await aliasResolver.resolveTypeText('gimbal_control_t', [['roll_angle']]);
    check('live F4 tag/global alias collision resolves the original typedef without looping', () => {
        assert.strictEqual(aliasLayout.byteSize, 1076);
        assert.strictEqual(resolveMemberPath(aliasLayout, ['roll_angle']).offset, 232);
        assert(!aliasCommands.includes('whatis /r gimbal_control'));
    });
    const cyclicResolver = new TypeResolver({
        console: async (command) => command.endsWith(' A') ? 'type = B' : 'type = A',
        evaluate: async () => '4'
    });
    const cycle = await cyclicResolver.resolveTypeText('A');
    check('even cyclic ptype output terminates safely', () => assert.strictEqual(cycle, undefined));
    const commands = [];
    const transport = makeFakeTransport('', {}, { gimbal: 0x20000000 }, new Map());
    transport.sendCliCommand = async (command) => {
        commands.push(command);
        if (command === 'maintenance info sections') {
            return ' [1] 0x20000000->0x20010000 at 0x0: .bss ALLOC\n';
        }
        if (!(command in queries)) { throw new Error(`Unexpected recursive query: ${command}`); }
        return queries[command];
    };
    const evaluate = transport.evaluateNumber.bind(transport);
    transport.evaluateNumber = async (expression) => {
        const captured = queries[`print ${expression}`];
        return captured ? /^\$\d+ = (.*)$/m.exec(captured)[1] : evaluate(expression);
    };
    const resolver = new TypeResolver({ console: (cmd) => transport.sendCliCommand(cmd), evaluate: (expr) => transport.evaluateNumber(expr) });
    check('F4 fixture has the 1076-byte gimbal and 804-byte Kalman member', () => {
        assert(queries['ptype /o gimbal_control_t'].includes('1076'));
        assert(queries['ptype /o gimbal_kalman_t'].includes('804'));
    });
    const kind = await resolver.classifyTypeText('gimbal_kalman_t');
    check('classification needs one declaration query and no member layout', () => {
        assert.strictEqual(kind, 'struct');
        assert.deepStrictEqual(commands, ['whatis /r gimbal_kalman_t']);
    });
    const variables = new Map();
    const names = new Map();
    const parents = new Map();
    const nodes = [];
    const add = (id, type, count, parent, key) => {
        const handle = names.size + 1;
        variables.set(handle, buildVariable(handle, id, type, count, count ? '{...}' : '0'));
        names.set(id, handle);
        if (parent) { parents.set(id, { parent, key }); }
        nodes.push({ id, parent, kind: 'container' });
    };
    add('gimbal', 'gimbal_control_t', 14);
    add('roll', 'fp32', 0, 'gimbal', 'roll_angle');
    add('mode', 'gimbal_mode_e', 0, 'gimbal', 'gimbal_behaviour');
    add('vision', 'bool_t', 0, 'gimbal', 'vision_flag');
    add('kalman', 'gimbal_kalman_t', 34, 'gimbal', 'gimbal_kalman');
    const store = { variableHandlesReverse: names, variableHandles: { get: (id) => variables.get(id) }, variableParents: parents };
    const engine = new LiveMemoryEngine(store, transport, () => ({
        mode: 'auto', maxBlockBytes: 2048, mergeGapBytes: 512, maxDepth: 8, extraRamRegions: []
    }), resolver);
    const memory = new Map();
    poke(memory, 0x200000e8, Buffer.from([0, 0, 0xc0, 0x3f, 2])); // roll = 1.5, mode = GIMBAL_SPIN
    poke(memory, 0x20000430, Buffer.from([1])); // vision flag
    transport.readMemoryRange = async (address, length) => {
        transport.calls.push({ address, length });
        return { address, data: Buffer.from(Array.from({ length }, (_, i) => memory.get(address + i) || 0)), fragments: 1 };
    };
    engine.setSubscription(1, nodes.slice());
    const first = await engine.sample();
    check('initial scalar frame skips the Kalman type tree and reads six bytes', () => {
        assert.strictEqual(first.stats.phase, 'sample', JSON.stringify(first.stats));
        assert.strictEqual(first.values.find((v) => v.id === 'roll').value, '1.5');
        assert.strictEqual(first.values.find((v) => v.id === 'mode').value, 'GIMBAL_SPIN');
        assert.strictEqual(first.values.find((v) => v.id === 'vision').value, '1');
        assert.strictEqual(first.stats.receivedBytes, 6);
        assert(!commands.includes('ptype /o gimbal_kalman_t'));
    });
    add('yaw', 'gimbal_axis_t', 2, 'gimbal', 'yaw_motor');
    add('axis', 'axis_state_t', 8, 'yaw', 'axis');
    add('feedback', 'fp32', 0, 'axis', 'abs_fb');
    add('kalman_debug', 'float', 0, 'kalman', 'debug_y_sk');
    add('kalman_array', 'float [2]', 2, 'kalman', 'Auto_Error_Yaw');
    add('kalman_element', 'float', 0, 'kalman_array', '1');
    poke(memory, 0x2000008c, Buffer.from([0, 0, 0x20, 0x40])); // yaw_motor.axis.abs_fb offset 140
    poke(memory, 0x2000010c, Buffer.from([0, 0, 0x60, 0x40])); // Kalman debug offset 268
    poke(memory, 0x20000404, Buffer.from([0, 0, 0xc0, 0x40])); // Kalman array element offset 1028
    poke(memory, 0x200000e8, Buffer.from([0, 0, 0x80, 0x40])); // roll changes to 4
    engine.setSubscription(2, nodes.slice());
    const expanded = await engine.sample();
    check('new nested leaves map at real F4 offsets while existing values keep updating', () => {
        assert.strictEqual(expanded.values.find((v) => v.id === 'feedback').value, '2.5');
        assert.strictEqual(expanded.values.find((v) => v.id === 'kalman_debug').value, '3.5');
        assert.strictEqual(expanded.values.find((v) => v.id === 'kalman_element').value, '6');
        assert.strictEqual(expanded.values.find((v) => v.id === 'roll').value, '4');
        assert.strictEqual(expanded.stats.fallbackFieldCount, 0);
        assert(!commands.some((c) => /extKalman_t|arm_matrix_instance_f32|kalman_filter_t/.test(c)));
        assert.strictEqual(commands.filter((c) => c === 'ptype /o gimbal_control_t').length, 1);
        assert.strictEqual(commands.filter((c) => c === 'maintenance info sections').length, 1);
    });
    const before = commands.length;
    poke(memory, 0x200000e8, Buffer.from([0, 0, 0xa0, 0x40]));
    const steady = await engine.sample();
    check('steady frames update locally without additional GDB type queries', () => {
        assert.strictEqual(steady.values.find((v) => v.id === 'roll').value, '5');
        assert.strictEqual(commands.length, before);
    });
    const read = transport.readMemoryRange;
    transport.readMemoryRange = async (address, length) => {
        if (address >= 0x20000400) { throw new Error('probe rejected this block'); }
        return read(address, length);
    };
    const partial = await engine.sample();
    check('a failed distant block leaves the other gimbal fields updating and reports the cause', () => {
        assert.strictEqual(partial.values.find((v) => v.id === 'roll').value, '5');
        assert.strictEqual(partial.values.find((v) => v.id === 'vision').status, 'unavailable');
        assert(partial.stats.errors.some((error) => error.includes('probe rejected this block')));
    });
}

/* ------------------------------------------------------------------ */
(async () => {
    await engineChecks();
    await fieldCountChecks();
    await nestedContainerChecks();
    await splitAndPrepareChecks();
    await typedefPointerChecks();
    await pointerArrayChecks();
    await largeGimbalChecks();
    console.log(failures ? `\n${failures}/${checks} checks failed` : `\nall ${checks} checks passed`);
    process.exit(failures ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
