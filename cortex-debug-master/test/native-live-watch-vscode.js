/* Opt-in integration: launch VS Code with --extensionDevelopmentPath=<repo>
 * --extensionTestsPath=<this file>, installed cpptools, and an empty temp workspace.
 * Uses an actual frozen DebugSession and the shared Live Watch/Live Plot frontend. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-live-vscode-'));
    const executable = path.join(directory, 'counter');
    const source = path.join(directory, 'counter.cpp');
    fs.writeFileSync(source, '#include <unistd.h>\n'
        + 'struct State { int tick; double value; int array[3]; } state = {0, 1.25, {1,2,3}};\n'
        + 'int main() { for(int i=0;i<2000;i++) {state.tick++; state.value+=.01; usleep(10000);} }\n');
    execFileSync('g++', ['-g', '-O0', source, '-o', executable]);
    const events = [];
    const samples = [];
    let original;
    let listener;
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
        createDebugAdapterTracker: () => ({ onDidSendMessage: (message) => {
            if (message.type === 'event') { events.push(message.event); }
        } })
    });
    try {
        const rm = await vscode.extensions.getExtension('rm-local.rm-debug').activate();
        await vscode.extensions.getExtension('ms-vscode.cpptools').activate();
        assert(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
            name: 'MuJoCo Live Watch regression', type: 'cppdbg', request: 'launch',
            program: executable, cwd: directory, MIMode: 'gdb', miDebuggerPath: '/usr/bin/gdb', externalConsole: false
        }));
        original = vscode.debug.activeDebugSession;
        const live = rm.nativeLiveWatch.getSession(original);
        assert(live, 'native session must be registered');
        listener = rm.liveWatchProvider.onDidCompleteSample((sample) => samples.push(sample));
        rm.liveWatchProvider.addWatchExpr('state', live, true);
        rm.liveWatchProvider.setViewExpanded('state', true);
        rm.liveWatchProvider.setPlotPaths(new Set(['state\x1ftick']));
        let first;
        for (let i = 0; i < 40; i++) {
            first = rm.liveWatchProvider.getViewRows().find((row) => row.label === 'tick' && /^\d+$/.test(row.value));
            if (first) { break; }
            await delay(100);
        }
        assert(first, 'shared frontend must discover numeric fields');
        await delay(600);
        const second = rm.liveWatchProvider.getViewRows().find((row) => row.label === 'tick');
        assert(Number(second.value) > Number(first.value), 'shared UI must sample while running');
        assert(samples.some((sample) => Number(sample.values['state\x1ftick']) > 0), 'samples must reach Live Plot');
        const root = await live.customRequest('liveEvaluate', { expression: 'state' });
        const children = await live.customRequest('liveVariables', { variablesReference: root.variablesReference });
        const array = children.variables.find((child) => child.name === 'array');
        const elements = await live.customRequest('liveVariables', { variablesReference: array.variablesReference, start: 1, count: 1 });
        assert.strictEqual(elements.variables[0].name, '[1]');
        assert.strictEqual((await live.customRequest('liveSetValue', { name: elements.variables[0].gdbVarName, value: '42' })).value, '42');
        assert.strictEqual(events.filter((event) => event === 'stopped').length, 0, 'sampling/writing must not pause the program');
        await vscode.debug.stopDebugging(original);
        await delay(200);
        assert.strictEqual(rm.nativeLiveWatch.getSession(original), undefined, 'termination must detach native sampling');
        original = undefined;
        console.log('Native Live Watch VS Code integration: frozen sessions, UI values, plots, arrays, writes and cleanup passed');
    } finally {
        listener?.dispose();
        tracker.dispose();
        if (original) { await vscode.debug.stopDebugging(original); }
        fs.rmSync(directory, { recursive: true, force: true });
    }
};
