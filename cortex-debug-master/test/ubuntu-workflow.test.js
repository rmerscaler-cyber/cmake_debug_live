const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const tools = require('../out/src/frontend/rm-tools');

assert.strictEqual(process.platform, 'linux', 'Run these integration checks on Linux');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-ubuntu-'));
const bin = path.join(temporary, 'Tool Kit\'s bin');
const project = path.join(temporary, 'STM32 Project\'s sources');
const scripts = path.join(temporary, 'share/openocd/scripts');
const originalPath = process.env.PATH;
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project);
fs.mkdirSync(path.join(scripts, 'interface'), { recursive: true });
fs.mkdirSync(path.join(scripts, 'target'));
for (const config of ['interface/cmsis-dap.cfg', 'interface/stlink.cfg', 'target/stm32f1x.cfg']) {
    fs.writeFileSync(path.join(scripts, config), '# fixture');
}
function executable(name, body = '') {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/bash\n' + body, { mode: 0o755 });
    return file;
}
const gcc = executable('arm-none-eabi-gcc');
const gdb = executable('gdb-multiarch');
const cmake = executable('cmake', `printf '%s\n' "$@" >> ${tools.bashQuote(path.join(temporary, 'cmake.args'))}\n`);
const openocd = executable('openocd', `printf '%s\n' "$@" > ${tools.bashQuote(path.join(temporary, 'openocd.args'))}\n`);
const jlinkServer = executable('JLinkGDBServerCLExe');
const commander = executable('JLinkExe', `printf '%s\n' "$@" > ${tools.bashQuote(path.join(temporary, 'jlink.args'))}\n`
    + 'while [ "$#" -gt 0 ]; do\n'
    + `if [ "$1" = '-CommandFile' ]; then /bin/cat "$2" > ${tools.bashQuote(path.join(temporary, 'jlink.command'))}; fi\nshift\ndone\n`);
const ninja = executable('ninja');
// A shell fixture keeps login profile changes from polluting discovery checks.
const shell = executable('bash', '/bin/bash -c "$2"\n');
const nonExecutable = path.join(bin, 'not-executable');
fs.writeFileSync(nonExecutable, '');
const machine = {
    bashPath: shell, gitBashPath: 'C:/Git/bin/bash.exe', armGccPath: gcc, armGdbPath: gdb,
    cmakePath: cmake, ninjaPath: ninja, openocdPath: openocd, openocdScriptsPath: scripts,
    jlinkGdbServerPath: jlinkServer, jlinkCommanderPath: commander
};
const workspace = {};
const debuggerSettings = {};
const launch = { configurations: [{ name: 'Keep existing', type: 'cppdbg' }] };
const updates = [];
let probe = 'daplink';
const messages = [];
const information = [];
const messageActions = [];
const debugLaunches = [];
const folder = { uri: { fsPath: project } };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const settings = (values, section) => ({
    get: (key, fallback) => values[key] ?? fallback,
    inspect: () => ({}),
    update: async (key, value, target) => {
        values[key] = value;
        updates.push([section, key, target]);
    }
});
const vscode = {
    TreeItem: class {}, ThemeIcon: class {},
    EventEmitter: class { fire() {} dispose() {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    Uri: { file: (file) => ({ fsPath: file }) },
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 }, ProgressLocation: { Notification: 15 },
    extensions: { getExtension: () => undefined },
    workspace: {
        workspaceFolders: [folder],
        createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        openTextDocument: async (uri) => ({ getText: () => fs.readFileSync(uri.fsPath, 'utf8') }),
        getConfiguration: (section, uri) => settings(section === 'rm-debug'
            ? (uri ? workspace : machine)
            : section === 'cortex-debug' ? debuggerSettings : section === 'launch' ? launch : {}, section)
    },
    window: {
        showQuickPick: async (items, options) => options.canPickMany
            ? items
            : options.title?.includes('调试器')
                ? items.find((item) => item.value === probe)
                : items[0],
        showInputBox: async (options) => options.title.includes('芯片配置')
            ? 'target/stm32f1x.cfg'
            : options.title.includes('芯片型号') ? 'STM32F103C8' : options.value,
        showWarningMessage: (message) => { throw new Error(message); },
        showErrorMessage: async (message, ...actions) => {
            messages.push(message);
            messageActions.push(actions);
        },
        showInformationMessage: (message) => information.push(message),
        withProgress: async (_options, callback) => callback({}, token)
    },
    debug: { startDebugging: async (_folder, configuration) => {
        debugLaunches.push(configuration);
        return true;
    } }
};
class Port extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.isOpen = true;
    }

    open(callback) { callback(); }
    close() { this.isOpen = false; }
}
const samples = [];
class Panel {
    constructor(_context, _provider, onClosed) { this.onClosed = onClosed; }
    reveal() {} setSerialInfo() {} setSerialStatus() {} setSerialSeries() {}
    dispose() { this.onClosed(); }
    addSerialSample(timestamp, hz, values) { samples.push({ timestamp, hz, values }); }
}
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
    if (request === 'vscode') { return vscode; }
    if (request === 'serialport') { return { SerialPort: Port }; }
    if (request === './live-plot' && parent.filename.endsWith('serial-plot.js')) { return { LivePlotPanel: Panel }; }
    return originalLoad.call(this, request, parent, main);
};
const { RmWorkflow } = require('../out/src/frontend/rm-workflow');
const { CMakeProjectProvider } = require('../out/src/frontend/cmake-project');
const { SerialPlot } = require('../out/src/frontend/views/serial-plot');

(async () => {
    try {
        process.env.PATH = bin;
        assert.strictEqual(tools.toolName('openocd'), 'openocd');
        assert.strictEqual(tools.configuredBash(settings(machine)), shell);
        assert.strictEqual(tools.bashPath('/a/STM32 Project\'s sources'), '/a/STM32 Project\'s sources');
        assert(!tools.executableFile(nonExecutable));
        assert.deepStrictEqual(tools.executableCandidates('openocd', shell), [openocd]);
        assert.strictEqual(tools.discoverArmGdb(shell, gcc, 'C:/ARM/gdb.exe'), gdb, 'Ubuntu GDB fallback must work');
        const armGdb = executable('arm-none-eabi-gdb');
        assert.strictEqual(tools.discoverArmGdb(shell, gcc, ''), armGdb, 'prefer the matching ARM toolchain');
        executable('arm-none-eabi-gdb', 'exit 1\n');
        assert.strictEqual(tools.discoverArmGdb(shell, gcc, ''), gdb, 'fall back when ARM GDB cannot start on Ubuntu');
        assert.strictEqual(tools.discoverArmGdb(shell, gcc, gdb), gdb, 'respect a valid user selection');
        const upper = executable('CaseTool');
        const lower = executable('casetool');
        assert.deepStrictEqual(tools.uniqueFiles([upper, lower, upper, nonExecutable]), [upper, lower]);
        fs.writeFileSync(path.join(project, 'CMakeLists.txt'), 'project(firmware LANGUAGES C)\nadd_library(firmware main.c Main.c)\n');
        fs.writeFileSync(path.join(project, 'main.c'), '');
        fs.writeFileSync(path.join(project, 'Main.c'), '');
        const provider = new CMakeProjectProvider(async () => project, () => path.join(project, 'missing.json'));
        await provider.load();
        assert.strictEqual(provider.getGroups()[0].sources.length, 2, 'case-distinct Linux sources must both survive');

        const workflow = Object.create(RmWorkflow.prototype);
        const output = [];
        workflow.output = { appendLine: (line) => output.push(line), append: (text) => output.push(text), clear() {}, show() {} };
        workflow.workspaceFolder = async () => folder;
        workflow.projectDirectory = async () => project;
        workflow.desktop = { isEnabled: () => false };
        workflow.mujoco = { isEnabled: () => false };
        workflow.tree = { refresh() {} };
        workflow.failedBuildProjects = new Set();
        workflow.failedFlashProjects = new Set();
        workflow.diagnostics = { clear() {} };
        workflow.saveClangdSettings = async () => {};
        const propertiesFile = path.join(project, '.vscode', 'c_cpp_properties.json');
        fs.mkdirSync(path.dirname(propertiesFile));
        fs.writeFileSync(propertiesFile, '// Keep editor settings\n' + JSON.stringify({ version: 4, configurations: [
            { name: 'existing', cStandard: 'c17', cppStandard: 'c++17', includePath: ['custom/include'] },
            { name: 'rm_debug' }
        ] }));
        for (probe of ['daplink', 'stlink', 'jlink']) {
            await workflow.configure();
            const propertiesText = fs.readFileSync(propertiesFile, 'utf8');
            const properties = require('jsonc-parser').parse(propertiesText);
            assert(propertiesText.includes('// Keep editor settings'));
            assert(properties.configurations.every((configuration) => configuration.cppStandard === 'c++20'));
            assert.strictEqual(properties.configurations[0].cStandard, 'c17');
            assert.deepStrictEqual(properties.configurations[0].includePath, ['custom/include']);
            assert.strictEqual(properties.configurations[1].cStandard, 'c11');
            const generated = launch.configurations.find((config) => config.type === 'cortex-debug');
            assert(generated && generated.liveWatch.enabled);
            assert(launch.configurations.some((config) => config.name === 'Keep existing'));
            assert.strictEqual(generated.servertype, probe === 'jlink' ? 'jlink' : 'openocd');
            if (probe !== 'jlink') {
                assert.strictEqual(generated.configFiles[0], probe === 'daplink' ? 'interface/cmsis-dap.cfg' : 'interface/stlink.cfg');
            }
            const firmware = path.join(project, workspace.firmwarePath);
            fs.mkdirSync(path.dirname(firmware), { recursive: true });
            fs.writeFileSync(firmware, 'fixture elf');
            await workflow.build();
            assert.strictEqual(workflow.state, '编译成功');
            await workflow.flash();
            assert.strictEqual(workflow.state, '烧录成功');
            await workflow.debug();
            assert.strictEqual(debugLaunches.at(-1).gdbPath, gdb);
            assert.strictEqual(debugLaunches.at(-1).armToolchainPath, bin);
        }
        assert(updates.some(([, key]) => key === 'gdbPath.linux'));
        assert(updates.some(([, key]) => key === 'openocdPath.linux'));
        assert(!updates.some(([, key]) => key.endsWith('.windows') || key === 'gitBashPath'));
        assert(fs.readFileSync(path.join(temporary, 'openocd.args'), 'utf8').includes(`program {${path.join(project, workspace.firmwarePath)}}`));
        assert(fs.readFileSync(path.join(temporary, 'jlink.command'), 'utf8').includes('loadfile "' + project));
        const commanderArgs = fs.readFileSync(path.join(temporary, 'jlink.args'), 'utf8').trim().split('\n');
        assert(!fs.existsSync(commanderArgs[commanderArgs.indexOf('-CommandFile') + 1]), 'temporary flash script must be removed');
        assert.strictEqual(messages.length, 0, messages.join('\n'));
        assert.strictEqual(await workflow.runBash(`test -x ${tools.bashQuote(gcc)} && printf '%s' "$PATH"`, project, token, false), 0);
        assert(output.some((line) => line.includes(bin)), 'configured tool paths must reach the child process');
        const separateGdb = path.join(temporary, 'gdb-multiarch');
        fs.copyFileSync(gdb, separateGdb);
        await workflow.saveGdbSettings(separateGdb);
        assert.strictEqual(debuggerSettings['armToolchainPath.linux'], bin, 'binutils must remain beside GCC, not multiarch GDB');

        // Execute real child processes without touching a probe. Each failure must analyze only its own stdout/stderr.
        const failureCases = [
            ['printf "Open On-Chip Debugger 0.11.0\\n"; printf "Error: LIBUSB_ERROR_ACCESS\\nError: open failed\\n" >&2; exit 1', 'USB 探针访问权限不足'],
            ['printf "Error: unable to find a matching CMSIS-DAP device\\n" >&2; exit 7', '未找到或无法打开 Link 探针'],
            ['printf "Error: verification failed\\n"; exit 2', 'Flash 写入或校验失败'],
            ['printf "unclassified error\\n"; exit 3', '现有日志不足以确定失败原因']
        ];
        for (const [command, cause] of failureCases) {
            output.length = 0;
            messages.length = 0;
            workspace.flashCommand = command;
            await workflow.flash();
            assert.strictEqual(workflow.state, '烧录失败');
            assert(workflow.failedFlashProjects.has(project));
            assert(messages[0].includes(cause), messages[0]);
            assert(output.join('').includes('日志依据：'));
            assert(output.join('').includes('退出码'));
            assert.deepStrictEqual(messageActions.at(-1), ['查看分析与日志', '配置工程和工具路径']);
            if (!command.includes('LIBUSB_ERROR_ACCESS')) {
                assert(!output.join('').includes('USB 探针访问权限不足'), 'old logs must not leak into a new flash');
            }
        }
        const chunks = [];
        await workflow.runBash('printf \'\\346\'; /bin/sleep 0.02; printf \'\\265\\213\\350\\257\\225\'', project, token, false, (text) => chunks.push(text));
        assert.strictEqual(chunks.join(''), '测试', 'UTF-8 split across process chunks must stay readable');

        output.length = 0;
        messages.length = 0;
        workspace.flashCommand = 'exit 4';
        token.isCancellationRequested = true;
        await workflow.flash();
        token.isCancellationRequested = false;
        assert.strictEqual(workflow.state, '烧录已取消');
        assert.strictEqual(messages.length, 0, 'cancellation should not report hardware failure');
        assert(!output.join('').includes('本次烧录失败分析'));
        assert(information.at(-1).includes('固件可能未完整写入'));
        workspace.flashCommand = 'exit 0';
        await workflow.flash();
        assert.strictEqual(workflow.state, '烧录成功');
        assert(!workflow.failedFlashProjects.has(project), 'a successful retry must clear the flash failure gate');
        delete workspace.flashCommand;

        const plot = new SerialPlot({}, '/dev/ttyACM0', () => {});
        assert.strictEqual(plot.port.options.path, '/dev/ttyACM0');
        plot.port.emit('data', Buffer.from('RM2,100,motor.speed=1.5,motor.current=-2\r'));
        assert.strictEqual(samples.length, 0);
        plot.port.emit('data', Buffer.from('\nRM2,200,motor.speed=2.5,motor.current=-1\n'));
        assert.strictEqual(samples.length, 2, 'both CRLF and LF telemetry frames must be accepted');
        assert.strictEqual(samples[1].values['motor.speed'], 2.5);
        assert.strictEqual(samples[1].hz, 10);
        assert(samples[1].timestamp > samples[0].timestamp);
        plot.port.emit('data', Buffer.from('RM2,300,motor.speed=invalid\n'));
        assert.strictEqual(samples.length, 2, 'malformed frames must not reach the plot');
        plot.dispose();
        assert.strictEqual(plot.port.isOpen, false);
        console.log('Ubuntu discovery, configuration, build/flash commands, debug paths, CMake case sensitivity and serial waveform checks passed');
    } finally {
        Module._load = originalLoad;
        process.env.PATH = originalPath;
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
