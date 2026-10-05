/*
 * Pure-function checks for the live-memory sampler modules.
 *
 * Run with:  npm run test-compile && node test/live-memory-pure.test.js
 * Requires no VS Code instance; uses the captured H7 `ptype /o` fixtures.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const types = require('../out/src/backend/live-memory-types.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'live-memory');
let failures = 0;
let checks = 0;

function check(name, fn) {
    checks++;
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

function extractAggregateBlocks(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!/^type\s*=\s*(?:struct|union)\b/.test(line)) { continue; }
        const collected = [line];
        for (let j = i + 1; j < lines.length; j++) {
            collected.push(lines[j]);
            if (lines[j].trim() === '}') {
                i = j;
                break;
            }
        }
        const parsed = types.parseAggregatePtypeOutput(collected.join('\n'), `fixture${blocks.length}`);
        blocks.push(parsed);
    }
    return blocks;
}

function byName(aggregate) {
    return new Map(aggregate.members.map((m) => [m.name, m]));
}

const main = fs.readFileSync(path.join(fixtureDir, 'h7-ptype.txt'), 'utf8');
const nested = fs.readFileSync(path.join(fixtureDir, 'h7-nested-ptype.txt'), 'utf8');
const bitfield = fs.readFileSync(path.join(fixtureDir, 'h7-bitfield-ptype.txt'), 'utf8');

const mainBlocks = extractAggregateBlocks(main);       // motor_base, RC_ctrl, chassis_move
const nestedBlocks = extractAggregateBlocks(nested);   // cmd .. motor_reg
const bitfieldBlocks = extractAggregateBlocks(bitfield);

console.log('== type text helpers ==');
check('arraySuffix int16_t ch[4]', () => {
    const a = types.arraySuffix('int16_t ch[4]');
    assert.strictEqual(a.base, 'int16_t ch');
    assert.deepStrictEqual(a.dims, [4]);
});
check('isPointerText motor_base_t *', () => assert.strictEqual(types.isPointerText('motor_base_t *'), true));
check('isPointerText function pointer', () => assert.strictEqual(types.isPointerText('void (*)(void)'), false));
check('isFunctionPointerText typedef return', () => assert.strictEqual(types.isFunctionPointerText('uint8_t (*f)(int)'), true));
check('normalize strips const/volatile', () => assert.strictEqual(types.normalizeTypeText('const volatile uint32_t *'), 'uint32_t *'));

console.log('== ptype /o parsing ==');
check('fixture block counts', () => {
    assert.strictEqual(mainBlocks.length, 3);
    assert.strictEqual(nestedBlocks.length, 8);
    assert.strictEqual(bitfieldBlocks.length, 2);
});

check('motor_base_t aggregate', () => {
    const parsed = mainBlocks[0];
    assert.strictEqual(parsed.byteSize, 348);
    const members = byName(parsed);
    assert.strictEqual(members.get('fb').byteOffset, 12);
    assert.strictEqual(members.get('ctrl').byteOffset, 52);
    assert.strictEqual(members.get('online').byteOffset, 344);
    assert.strictEqual(members.get('driver').typeText, 'const motor_driver_ops_t *');
});

check('RC_ctrl_t aggregate + inline struct', () => {
    const parsed = mainBlocks[1];
    assert.strictEqual(parsed.byteSize, 28);
    assert.strictEqual(parsed.members.length, 3);
    const rc = parsed.members[0];
    assert.strictEqual(rc.name, 'rc');
    assert.strictEqual(rc.byteOffset, 0);
    assert.strictEqual(rc.inline.kind, 'struct');
    assert.strictEqual(rc.inline.byteSize, 18);
    assert.strictEqual(rc.inline.members.length, 5);
    const ch = rc.inline.members[0];
    assert.strictEqual(ch.name, 'ch');
    assert.deepStrictEqual(ch.arrayDims, [4]);
    const s = rc.inline.members[1];
    assert.strictEqual(s.name, 's');
    assert.strictEqual(s.byteOffset, 8);
    assert.deepStrictEqual(s.arrayDims, [4]);
    const mouse = parsed.members[1];
    assert.strictEqual(mouse.byteOffset, 18);
    assert.strictEqual(mouse.inline.members[0].byteOffset, 0,
        'inline member offsets must be relative to the inline struct');
    assert.strictEqual(mouse.inline.members[4].byteOffset, 7);
    const key = parsed.members[2];
    assert.strictEqual(key.byteOffset, 26);
    assert.strictEqual(key.inline.members[0].byteOffset, 0);
});

check('chassis_move_t aggregate', () => {
    const parsed = mainBlocks[2];
    assert.strictEqual(parsed.byteSize, 404);
    const members = byName(parsed);
    assert.strictEqual(members.get('command').byteOffset, 0);
    assert.strictEqual(members.get('steer_motor').byteOffset, 68);
    assert.deepStrictEqual(members.get('steer_motor').arrayDims, [4]);
    assert.strictEqual(members.get('power_k').byteOffset, 88);
    assert.deepStrictEqual(members.get('power_k').arrayDims, [4, 6]);
    assert.strictEqual(members.get('chassis_angle_pid').byteOffset, 184);
    assert.strictEqual(members.get('chassis_mode').byteSize, 1);
});

check('cmd_t aggregate', () => {
    assert.strictEqual(nestedBlocks[0].byteSize, 48);
});

check('pid_type_def aggregate', () => {
    const parsed = nestedBlocks[1];
    assert.strictEqual(parsed.byteSize, 132);
    const members = byName(parsed);
    assert.strictEqual(members.get('error').byteOffset, 64);
    assert.deepStrictEqual(members.get('error').arrayDims, [2]);
    assert.strictEqual(members.get('feedforward').byteOffset, 80);
});

check('motor_feedback_t aggregate', () => {
    const parsed = nestedBlocks[2];
    assert.strictEqual(parsed.byteSize, 40);
    assert.strictEqual(byName(parsed).get('temperature').typeText, 'int8_t');
});

check('motor_control_t aggregate', () => {
    assert.strictEqual(nestedBlocks[3].byteSize, 276);
});

check('motor_driver_ops_t function pointers', () => {
    const parsed = nestedBlocks[6];
    assert.strictEqual(parsed.byteSize, 28);
    const members = byName(parsed);
    assert.strictEqual(members.get('register_instance').functionPointer, true);
    assert.strictEqual(members.get('register_instance').byteOffset, 4);
    assert.strictEqual(members.get('name').byteOffset, 0);
});

check('motor_reg_t aggregate', () => {
    assert.strictEqual(nestedBlocks[7].byteSize, 104);
});

check('power_estimate_t bitfield', () => {
    const parsed = bitfieldBlocks[0];
    assert.strictEqual(parsed.byteSize, 20);
    const lim = byName(parsed).get('lim_flag');
    assert(lim, 'lim_flag missing');
    assert.deepStrictEqual(lim.bitfield, { bitOffset: 0, bitSize: 1 });
    assert.strictEqual(lim.byteOffset, 14);
});

check('chassis_power_control_input_t pointer array', () => {
    const parsed = bitfieldBlocks[1];
    assert.strictEqual(parsed.byteSize, 108);
    const powerK = byName(parsed).get('power_k');
    assert.deepStrictEqual(powerK.arrayDims, [4]);
    assert.strictEqual(powerK.byteOffset, 64);
});

console.log(failures ? `\n${failures}/${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
