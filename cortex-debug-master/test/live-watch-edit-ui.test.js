// Exercise the actual webview script while samples arrive during editing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.listeners = {};
        this.style = {};
        this._text = '';
        this.classList = { add() {}, remove() {}, toggle() {} };
    }

    set textContent(text) {
        this._text = text;
        this.children = [];
    }

    get textContent() { return this._text; }
    get firstChild() { return this.children[0]; }
    get nextSibling() {
        return this.parent?.children[this.parent.children.indexOf(this) + 1];
    }

    append(...children) { children.forEach((child) => this.insertBefore(child)); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) {
        this.children = [];
        this._text = '';
        this.append(...children);
    }

    insertBefore(child, before) {
        child.remove();
        child.parent = this;
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }

    remove() {
        if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
        this.parent = undefined;
    }

    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute() {}
    querySelector() { return undefined; }
    contains() { return false; }
    focus() {}
    select() {}
    scrollIntoView() {}
    trigger(name, extras = {}) {
        this.listeners[name]?.({ target: this, preventDefault() {}, stopPropagation() {}, ...extras });
    }
}
const dom = new Map(['rows', 'actions', 'hz', 'count', 'add', 'writeStatus'].map((id) => [id, new Element()]));
const document = {
    getElementById: (id) => dom.get(id),
    createElement: (tag) => new Element(tag),
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; }
};
let onMessage;
const messages = [];
const context = vm.createContext({
    document, innerWidth: 500, innerHeight: 800,
    window: { addEventListener: (_name, listener) => { onMessage = listener; } },
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    requestAnimationFrame: (callback) => callback()
});
const html = fs.readFileSync(path.join(__dirname, '../resources/live-table.html'), 'utf8');
vm.runInContext(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/.exec(html)[1], context);
const row = { path: 'pid\u001fkp', label: 'kp', value: '1.25', editable: true, depth: 1 };
const sample = (value, sessionId = 'session1', editable = true) => onMessage({ data: {
    type: 'sample', sessionId, targetHz: 20, rows: [{ ...row, value, editable }]
} });
sample('1.25');
const entry = dom.get('rows').firstChild;
const value = entry.children[2];
value.trigger('dblclick');
let input = value.firstChild;
assert.strictEqual(input.value, '1.25');
input.value = '3.25';
sample('1.5');
assert.strictEqual(value.firstChild, input, 'sampling preserves the input element');
assert.strictEqual(input.value, '3.25', 'sampling preserves unsent text');
input.trigger('keydown', { key: 'Escape' });
assert.strictEqual(value.textContent, '1.5', 'cancel shows latest target sample');
assert.strictEqual(messages.filter((message) => message.type === 'setValue').length, 0);
entry.trigger('click');
document.listeners.keydown({ key: 'F2', preventDefault() {} });
input = value.firstChild;
input.value = '4';
input.trigger('keydown', { key: 'Enter' });
input.trigger('keydown', { key: 'Enter' });
const writes = messages.filter((message) => message.type === 'setValue');
assert.strictEqual(writes.length, 1, 'pending Enter does not send duplicate writes');
assert.strictEqual(writes[0].sessionId, 'session1');
assert.strictEqual(writes[0].value, '4');
sample('1.75');
assert.strictEqual(value.firstChild, input, 'pending input survives sampling');
onMessage({ data: { ...writes[0], type: 'writeResult', success: true, value: '4' } });
assert.strictEqual(value.textContent, '1.75', 'only actual samples replace the displayed value');
sample('4');
assert.strictEqual(value.textContent, '4');
value.trigger('dblclick');
input = value.firstChild;
input.value = '9';
input.trigger('keydown', { key: 'Enter' });
sample('1.25', 'session2');
assert.strictEqual(value.textContent, '1.25', 'switching session closes the editor');
const oldWrite = messages.filter((message) => message.type === 'setValue').at(-1);
onMessage({ data: { ...oldWrite, type: 'writeResult', success: true, value: '9' } });
assert.strictEqual(value.textContent, '1.25', 'old-session result cannot change new-session display');
sample('1.25', 'session2', false);
value.trigger('dblclick');
assert.strictEqual(value.firstChild, undefined, 'read-only row cannot enter edit mode');
console.log('Live Watch UI: sampling during edit, F2, Enter/Escape, duplicate writes and session isolation passed');

const matrixRow = {
    path: 'arm_application\u001fT_sy', label: 'T_sy', value: '2 × 3', depth: 1,
    expandable: true, expanded: true, displayMode: 'auto',
    matrixShape: { rows: 2, columns: 3, kind: 'eigen', automatic: true },
    matrix: { rows: 2, columns: 3, values: ['0', '1', '2', '10', '11', '12'], changed: Array(6).fill(false) }
};
function matrixSample(row) {
    onMessage({ data: { type: 'sample', sessionId: 'matrix-session', targetHz: 20, actualHz: 19.8, rows: [row] } });
}
matrixSample(matrixRow);
const matrixEntry = dom.get('rows').firstChild;
const mode = matrixEntry.children[3];
const panel = matrixEntry.children[4];
const table = panel.firstChild;
assert.strictEqual(table.children.length, 3, 'two logical rows and column headings');
assert.strictEqual(table.children[1].children[1].textContent, '0');
assert.strictEqual(table.children[1].children[3].textContent, '2');
assert.strictEqual(table.children[2].children[1].textContent, '10');
const firstCell = table.children[1].children[1];
matrixSample({ ...matrixRow, matrix: { ...matrixRow.matrix, values: ['42', '1', '2', '10', '11', '12'] } });
assert.strictEqual(panel.firstChild, table, 'sampling must preserve the table DOM');
assert.strictEqual(table.children[1].children[1], firstCell);
assert.strictEqual(firstCell.textContent, '42');
matrixSample({ ...matrixRow, matrix: { ...matrixRow.matrix, timestampMs: 1700000000123 } });
assert.match(panel.children[1].textContent, /最近采样 .*\.123 · 数值未变化/);
matrixSample({ ...matrixRow, matrix: { ...matrixRow.matrix, timestampMs: 1700000000456,
    values: ['42', '1', '2', '10', '11', '12'], changed: [true, false, false, false, false, false] } });
assert.match(panel.children[1].textContent, /\.456 · 数值已变化/);
assert.strictEqual(firstCell.textContent, '42');
mode.value = 'tree';
mode.trigger('change');
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'setDisplayMode', path: matrixRow.path, mode: 'tree'
});
matrixSample({ ...matrixRow, displayMode: 'tree', matrix: undefined });
assert.strictEqual(panel.hidden, true, 'default display hides the matrix grid');
matrixSample({ ...matrixRow, matrix: { ...matrixRow.matrix, values: [], error: '矩阵内存读取失败' } });
assert.strictEqual(panel.hidden, false);
assert.strictEqual(firstCell.textContent, '—', 'failed reads cannot display stale matrix cells');
assert.strictEqual(panel.children[1].textContent, '矩阵内存读取失败');
matrixSample({ ...matrixRow, expanded: false });
assert.strictEqual(panel.hidden, true, 'collapsed matrices hide the grid');
console.log('Matrix webview: rectangular grid, logical positions, stable DOM updates, mode switching and unavailable cells passed');
