const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { parse } = require('jsonc-parser');
const {
    MUJOCO_LAUNCH, MUJOCO_HEADLESS, MUJOCO_BUILD_TASK,
    isMujocoLaunch, isHeadlessLaunch, mujocoConfiguration, mergeMujocoFile
} = require('../out/src/frontend/mujoco-config');

const generated = mujocoConfiguration({
    python: '/venv with spaces/bin/python', gdb: '/usr/bin/gdb', cmake: '/usr/bin/cmake', compiler: '/usr/bin/g++',
    source: '${workspaceFolder}/simulation/native', build: '${workspaceFolder}/simulation/build/native',
    script: '${workspaceFolder}/simulation/scripts/run_sim.py', cwd: '${workspaceFolder}', duration: 10
});
const legacy = {
    name: 'MuJoCo: 嵌入式 C++ Debug（窗口）', type: 'cppdbg', request: 'launch', MIMode: 'gdb',
    program: '/usr/bin/python3', args: ['${workspaceFolder}/parallel_controller_mujoco/scripts/run_sim.py', '--embedded', '--log', '/tmp/test.csv'],
    preLaunchTask: 'MuJoCo: build embedded Debug'
};
const legacyHeadless = { ...legacy, name: 'MuJoCo: 嵌入式 C++ Debug（无窗口 10 秒）',
    args: [...legacy.args, '--headless', '--duration', '10'] };
const probe = { name: 'rm_debug: DAPLink', type: 'cortex-debug', servertype: 'openocd' };
assert(isMujocoLaunch(legacy));
assert(isMujocoLaunch({ ...legacy, name: 'Custom simulation' }));
assert(!isMujocoLaunch(probe));
assert(!isMujocoLaunch({ ...legacy, MIMode: 'lldb' }));
assert(!isHeadlessLaunch(legacy));
assert(isHeadlessLaunch(legacyHeadless));
assert(generated.launches.every(isMujocoLaunch));
assert(generated.launches.every((launch) => launch.setupCommands.some((cmd) => cmd.text === '-gdb-set breakpoint pending on')));
assert.strictEqual(generated.launches[0].program, '/venv with spaces/bin/python');
assert.deepStrictEqual(generated.launches[1].args.slice(-3), ['--headless', '--duration', '10']);
assert(generated.tasks[0].args.includes('-DCMAKE_BUILD_TYPE=Debug'));
assert(generated.tasks[0].args.includes('-DCMAKE_CXX_COMPILER=/usr/bin/g++'));
assert(generated.tasks.every((task) => task.type === 'process'));
assert.throws(() => mujocoConfiguration({ duration: 0 }), /大于 0/);
assert.throws(() => mujocoConfiguration({ duration: NaN }), /大于 0/);
const previous = { ...generated.launches[0], args: ['old/script.py', '--embedded', '--log', 'custom.csv'],
    sourceFileMap: { '/build': '/src' }, environment: [{ name: 'CUSTOM', value: 'keep' }],
    setupCommands: [{ text: 'set print elements 100' }] };
const text = '// Preserve comments\n' + JSON.stringify({ version: '0.2.0', configurations: [probe, legacy, legacyHeadless, previous] });
const merged = mergeMujocoFile(text, 'configurations', generated.launches);
assert(merged.includes('// Preserve comments'));
const configs = parse(merged).configurations;
assert.deepStrictEqual(configs.slice(0, 3), [probe, legacy, legacyHeadless]);
assert.strictEqual(configs[3].args[0], generated.launches[0].args[0]);
assert.deepStrictEqual(configs[3].args.slice(1), previous.args.slice(1));
assert.deepStrictEqual(configs[3].sourceFileMap, previous.sourceFileMap);
assert(configs[3].environment.some((item) => item.name === 'CUSTOM'));
assert(configs[3].setupCommands.some((item) => item.text === 'set print elements 100'));
assert.strictEqual(mergeMujocoFile(merged, 'configurations', generated.launches), merged, 'reconfiguration must be idempotent');
assert.throws(() => mergeMujocoFile('{broken', 'configurations', generated.launches), /格式无效/);
assert.throws(() => mergeMujocoFile('{"tasks":{}}', 'tasks', generated.tasks), /格式无效/);
const taskText = mergeMujocoFile('{"tasks":[{"label":"legacy build"}]}', 'tasks', generated.tasks);
assert.strictEqual(parse(taskText).tasks[0].label, 'legacy build');

let configurations = [probe, legacy, legacyHeadless];
let target = 'embedded';
let save = true;
let cpptools = true;
let mode = 'reuse';
const values = {};
const launches = [];
const executions = [];
const messages = [];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-mujoco-workflow-'));
const folder = { uri: { fsPath: temporary, toString: () => 'file://' + temporary } };
const task = { name: legacy.preLaunchTask, scope: folder };
const vscode = {
    TreeItem: class {}, EventEmitter: class {}, ThemeIcon: class {},
    Uri: { file: (file) => ({ fsPath: file }) }, Position: class {}, Range: class {},
    WorkspaceEdit: class {
        operations = [];
        createFile() {}
        replace(uri, _range, content) { this.operations.push([uri.fsPath, content]); }
        insert(uri, _position, content) { this.operations.push([uri.fsPath, content]); }
    },
    TreeItemCollapsibleState: { None: 0 }, ConfigurationTarget: { WorkspaceFolder: 3 },
    workspace: {
        textDocuments: [], saveAll: async () => save,
        openTextDocument: async (uri) => ({
            positionAt: (value) => value, getText: () => fs.readFileSync(uri.fsPath, 'utf8'), save: async () => true
        }),
        applyEdit: async (edit) => {
            for (const [file, content] of edit.operations) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, content);
            }
            return true;
        },
        getConfiguration: (section) => ({
            get: (key, fallback) => section === 'launch' ? configurations : key === 'target' ? target : values[key] ?? fallback,
            update: async (key, value) => {
                if (key === 'target') {
                    target = value;
                } else {
                    values[key] = value;
                }
            }
        })
    },
    window: {
        showQuickPick: async (items) => items.find((item) => item.reuse === (mode === 'reuse')) || items[0],
        showInputBox: async (options) => options.value,
        showErrorMessage: (message) => messages.push(message), showWarningMessage: (message) => messages.push(message),
        showInformationMessage: (message) => messages.push(message)
    },
    extensions: { getExtension: () => cpptools ? {} : undefined },
    commands: { executeCommand: async () => {} },
    debug: { activeDebugSession: undefined, startDebugging: async (...args) => {
        launches.push(args);
        return true;
    } },
    tasks: { taskExecutions: [], fetchTasks: async () => [task], executeTask: async (item) => executions.push(item) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, main);
};
const { MujocoWorkflow } = require('../out/src/frontend/mujoco-workflow');
const { RmWorkflow } = require('../out/src/frontend/rm-workflow');
Module._load = originalLoad;
const workflow = new MujocoWorkflow({ appendLine() {} });
async function run() {
    try {
        await workflow.debug(folder);
        await workflow.debug(folder, true);
        assert.deepStrictEqual(launches.map((item) => item[1]), [legacy.name, legacyHeadless.name],
            'existing configurations must start by name, including their original preLaunchTask');
        assert.strictEqual(target, 'embedded', 'explicit simulation commands must preserve embedded workflow selection');
        await workflow.build(folder);
        assert.strictEqual(executions[0], task, 'build must use the selected simulation task');
        vscode.tasks.taskExecutions = [{ task }];
        await workflow.build(folder);
        assert.strictEqual(executions.length, 1);
        vscode.tasks.taskExecutions = [];
        vscode.debug.activeDebugSession = { type: 'cortex-debug' };
        await workflow.build(folder);
        await workflow.debug(folder);
        assert.strictEqual(executions.length, 1);
        assert.strictEqual(launches.length, 2);
        vscode.debug.activeDebugSession = undefined;
        save = false;
        await workflow.debug(folder);
        assert.strictEqual(launches.length, 2, 'failed save must prevent launching');
        save = true;
        cpptools = false;
        await workflow.debug(folder);
        assert.strictEqual(launches.length, 2);
        cpptools = true;
        await workflow.configure(folder);
        assert.strictEqual(target, 'mujoco');
        assert.strictEqual(values['mujoco.launchName'], legacy.name);
        assert.strictEqual(values['mujoco.headlessLaunchName'], legacyHeadless.name);
        assert(workflow.isEnabled(folder));
        const host = { busy: false, workspaceFolder: async () => folder, mujoco: workflow,
            desktop: { isEnabled() { throw new Error('MuJoCo must route before desktop'); } } };
        await RmWorkflow.prototype.build.call(host);
        await RmWorkflow.prototype.debug.call(host);
        await RmWorkflow.prototype.flash.call(host);
        assert.strictEqual(executions.length, 2);
        assert.strictEqual(launches.length, 3);
        assert(messages.some((message) => message.includes('无需烧录')));
        configurations = [probe];
        await workflow.debug(folder);
        assert.strictEqual(launches.length, 3, 'missing simulation must never fall through to DAPLink');
        configurations = generated.launches;
        await workflow.debug(folder, true);
        assert.strictEqual(launches[3][1], MUJOCO_HEADLESS);
        assert.strictEqual(generated.launches[0].name, MUJOCO_LAUNCH);
        assert.strictEqual(generated.launches[0].preLaunchTask, MUJOCO_BUILD_TASK);
        mode = 'generate';
        target = 'embedded';
        values['mujoco.sourceDirectory'] = 'sim/native';
        values['mujoco.buildDirectory'] = 'sim/build/native';
        values['mujoco.script'] = 'sim/scripts/run_sim.py';
        values['mujoco.pythonPath'] = '/usr/bin/python3';
        fs.mkdirSync(path.join(temporary, 'sim/native'), { recursive: true });
        fs.mkdirSync(path.join(temporary, 'sim/scripts'), { recursive: true });
        fs.writeFileSync(path.join(temporary, 'sim/native/CMakeLists.txt'), 'project(sim LANGUAGES CXX)');
        fs.writeFileSync(path.join(temporary, 'sim/scripts/run_sim.py'), '');
        fs.mkdirSync(path.join(temporary, '.vscode'));
        const launchFile = path.join(temporary, '.vscode/launch.json');
        const tasksFile = path.join(temporary, '.vscode/tasks.json');
        fs.writeFileSync(launchFile, text);
        fs.writeFileSync(tasksFile, '{broken');
        await workflow.configure(folder);
        assert.strictEqual(fs.readFileSync(launchFile, 'utf8'), text, 'invalid task JSON must prevent all launch edits');
        assert.strictEqual(target, 'embedded');
        fs.writeFileSync(tasksFile, '{"version":"2.0.0","tasks":[{"label":"legacy build"}]}');
        vscode.workspace.textDocuments.push({ uri: { fsPath: launchFile }, isDirty: true });
        await workflow.configure(folder);
        assert.strictEqual(fs.readFileSync(launchFile, 'utf8'), text, 'dirty launch documents must be preserved');
        vscode.workspace.textDocuments = [];
        await workflow.configure(folder);
        assert.strictEqual(target, 'mujoco');
        const actual = parse(fs.readFileSync(launchFile, 'utf8')).configurations;
        assert.deepStrictEqual(actual.slice(0, 3), [probe, legacy, legacyHeadless]);
        assert.strictEqual(actual.find((item) => item.name === MUJOCO_LAUNCH).args[0], '${workspaceFolder}/sim/scripts/run_sim.py');
        assert.strictEqual(parse(fs.readFileSync(tasksFile, 'utf8')).tasks[0].label, 'legacy build');
        console.log('MuJoCo configuration preservation, existing-launch adoption, task routing and debug guards passed');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
