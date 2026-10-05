const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { parse } = require('jsonc-parser');
const {
    desktopConfiguration, isCppSource, isCOrCppSource, nativeCompiler,
    DESKTOP_BUILD_TASK, DESKTOP_CONFIGURE_TASK, DESKTOP_LAUNCH_NAME
} = require('../out/src/frontend/desktop-config');

const base = {
    platform: 'win32', debugger: 'gdb', mode: 'file',
    compiler: 'C:/Native Tools/bin/g++.exe', debuggerPath: 'C:/Native Tools/bin/gdb.exe',
    cCompiler: 'C:/Native Tools/bin/gcc.exe',
    cmake: 'C:/CMake/bin/cmake.exe', ninja: 'C:/Ninja/ninja.exe',
    project: '${workspaceFolder}', buildDirectory: '${workspaceFolder}/build/rm-desktop-gdb', program: '${workspaceFolder}/app.exe'
};

for (const name of ['main.cpp', 'main.cc', 'main.cxx', 'main.C', 'main.CPP', 'main.c++']) {
    assert(isCppSource(name), `${name} is a C++ translation unit`);
    assert(isCOrCppSource(name));
}
assert(!isCppSource('main.c'));
assert(isCOrCppSource('main.c'));
for (const name of ['file.hpp', 'file.cpp.bak', 'file.o', 'file.s']) {
    assert(!isCOrCppSource(name));
}
assert(!nativeCompiler('arm-none-eabi-g++.exe'));
assert(!nativeCompiler('arm-none-eabi-gdb.exe'));
assert(nativeCompiler('g++.exe'));

const gcc = desktopConfiguration(base);
assert.strictEqual(gcc.launch.type, 'cppdbg');
assert.strictEqual(gcc.launch.MIMode, 'gdb');
assert.strictEqual(gcc.launch.preLaunchTask, DESKTOP_BUILD_TASK);
assert(!('servertype' in gcc.launch) && !('gdbPath' in gcc.launch) && !('liveWatch' in gcc.launch));
assert.strictEqual(gcc.tasks[0].type, 'process', 'compiler paths and arguments must not be interpreted by a shell');
assert(gcc.tasks[0].args.includes('-g') && gcc.tasks[0].args.includes('-O0'));
assert(gcc.launch.program.endsWith('.exe'));
assert(gcc.tasks[0].options.env.PATH.replace(/\\/g, '/').includes('C:/Native Tools/bin'));
assert(gcc.tasks[0].options.env.PATH.includes('${env:PATH}'));
const msvc = desktopConfiguration({ ...base, debugger: 'msvc', compiler: 'C:/VS/cl.exe' });
assert.strictEqual(msvc.launch.type, 'cppvsdbg');
assert(!('MIMode' in msvc.launch));
assert(msvc.tasks[0].args.includes('/Zi') && msvc.tasks[0].args.includes('/DEBUG'));
assert.deepStrictEqual(msvc.tasks[0].problemMatcher, ['$msCompile']);
const linux = desktopConfiguration({ ...base, platform: 'linux', compiler: '/usr/bin/g++', debuggerPath: '/usr/bin/gdb' });
assert(!linux.launch.program.endsWith('.exe'));
assert(linux.tasks[0].options.env.PATH.endsWith(':${env:PATH}'));
const cmake = desktopConfiguration({ ...base, mode: 'cmake' });
assert.deepStrictEqual(cmake.tasks[1].dependsOn, [DESKTOP_CONFIGURE_TASK]);
assert.strictEqual(cmake.tasks[1].dependsOrder, 'sequence');
assert(cmake.tasks[0].args.includes('Ninja'));
assert(cmake.tasks[0].args.includes('-DCMAKE_CXX_COMPILER=' + base.compiler));
assert(cmake.tasks[0].args.includes('-DCMAKE_C_COMPILER=' + base.cCompiler));
assert(cmake.tasks[0].args.includes('-DCMAKE_BUILD_TYPE=Debug'));
assert(cmake.tasks[1].args.includes('Debug'));
const existing = desktopConfiguration({ ...base, mode: 'executable' });
assert.strictEqual(existing.tasks.length, 0);
assert(!('preLaunchTask' in existing.launch), 'existing binaries should never trigger an old compile task');
const lldb = desktopConfiguration({ ...base, platform: 'darwin', debugger: 'lldb', debuggerPath: '/usr/bin/lldb-mi' });
assert.strictEqual(lldb.launch.MIMode, 'lldb');
assert(!lldb.launch.setupCommands, 'GDB-only commands must not be sent to LLDB');

// Exercise actual workflow merging and entry points with the VS Code boundary mocked.
let mode = 'file';
let backend = 'gdb';
let cppStandard;
let activeDocument;
const messages = [];
const launches = [];
const executions = [];
const folder = { uri: { fsPath: 'C:/project', toString: () => 'file:///C:/project' } };
const vscode = {
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    Uri: { file: (file) => ({ fsPath: file }) },
    EventEmitter: class { fire() {} dispose() {} },
    workspace: {
        textDocuments: [], saveAll: async () => true, getWorkspaceFolder: () => folder,
        openTextDocument: async (uri) => ({ getText: () => fs.readFileSync(uri.fsPath, 'utf8') }),
        createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                if (section === 'launch') { return [gcc.launch]; }
                if (key === 'desktop.buildMode') { return mode; }
                if (key === 'target') { return 'desktop'; }
                if (key === 'desktop.backend') { return backend; }
                if (key === 'desktop.cppStandard') { return cppStandard ?? fallback; }
                return fallback;
            }
        })
    },
    window: {
        get activeTextEditor() { return activeDocument ? { document: activeDocument } : undefined; },
        showErrorMessage: (message) => messages.push(message), showWarningMessage: (message) => messages.push(message),
        showInformationMessage: (message) => messages.push(message)
    },
    extensions: { getExtension: () => ({ id: 'ms-vscode.cpptools' }) },
    debug: { startDebugging: async (...args) => {
        launches.push(args);
        return true;
    } },
    tasks: {
        taskExecutions: [], fetchTasks: async () => [{ name: DESKTOP_BUILD_TASK, scope: folder }],
        executeTask: async (task) => executions.push(task)
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, main);
};
const { DesktopWorkflow } = require('../out/src/frontend/desktop-workflow');
const { mixedCMakeLanguages, mixedCMakeCppStandard, CMakeProjectProvider } = require('../out/src/frontend/cmake-project');
Module._load = originalLoad;
const workflow = new DesktopWorkflow({ appendLine: () => {} });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-desktop-test-'));

async function run() {
    try {
        const file = path.join(temporary, 'launch.json');
        const previous = { ...gcc.launch, args: ['hello'], sourceFileMap: { '/build': '/source' },
            environment: [{ name: 'CUSTOM', value: 'keep' }, { name: 'PATH', value: 'old-toolchain' }] };
        fs.writeFileSync(file, '// Keep this comment\n' + JSON.stringify({ version: '0.2.0', configurations: [
            { name: 'STM32', type: 'cortex-debug' }, previous
        ] }, null, 4));
        const merged = workflow.mergedFile(file, 'configurations', [msvc.launch], [DESKTOP_LAUNCH_NAME], {});
        assert(merged.includes('// Keep this comment'));
        const configs = parse(merged).configurations;
        assert.strictEqual(configs[0].type, 'cortex-debug', 'embedded launch configs must survive desktop configuration');
        assert.deepStrictEqual(configs[1].args, ['hello']);
        assert.deepStrictEqual(configs[1].sourceFileMap, previous.sourceFileMap);
        assert(configs[1].environment.some((entry) => entry.name === 'CUSTOM'));
        assert(!configs[1].environment.some((entry) => entry.value === 'old-toolchain'));
        assert(!('MIMode' in configs[1]) && !('miDebuggerPath' in configs[1]) && !('setupCommands' in configs[1]));
        const direct = parse(workflow.mergedFile(file, 'configurations', [existing.launch], [DESKTOP_LAUNCH_NAME], {}));
        assert(!direct.configurations[1].preLaunchTask);
        fs.writeFileSync(file, '{broken');
        assert.throws(() => workflow.mergedFile(file, 'configurations', [gcc.launch], [DESKTOP_LAUNCH_NAME], {}), /格式无效/);
        const taskFile = path.join(temporary, 'tasks.json');
        fs.writeFileSync(taskFile, JSON.stringify({ tasks: [{ label: 'custom build' }, ...cmake.tasks] }));
        assert.deepStrictEqual(parse(workflow.mergedFile(taskFile, 'tasks', [],
            [DESKTOP_BUILD_TASK, DESKTOP_CONFIGURE_TASK], {})).tasks, [{ label: 'custom build' }]);
        vscode.workspace.textDocuments.push({ uri: { fsPath: taskFile }, isDirty: true });
        assert.throws(() => workflow.mergedFile(taskFile, 'tasks', [], [], {}), /请先保存/);
        await workflow.debug(folder);
        assert.strictEqual(launches.length, 0, 'single-file debug requires a saved active C++ document');
        activeDocument = { uri: { scheme: 'file' }, fileName: 'C:/project/main.cpp', isUntitled: false };
        assert.strictEqual(workflow.activeStandard(), '-std=c++20');
        backend = 'msvc';
        assert.strictEqual(workflow.activeStandard(), '/std:c++20');
        cppStandard = 'c++23';
        assert.strictEqual(workflow.activeStandard(), '/std:c++23', 'explicit single-file standard remains configurable');
        cppStandard = undefined;
        backend = 'gdb';
        await workflow.debug(folder);
        assert.strictEqual(launches[0][1], DESKTOP_LAUNCH_NAME, 'start the generated config by name so VS Code executes preLaunchTask');
        await workflow.build(folder);
        assert.strictEqual(executions.length, 1);
        mode = 'executable';
        await workflow.build(folder);
        assert.strictEqual(executions.length, 1, 'existing-program mode must not rebuild an active unrelated editor');
        assert(workflow.isEnabled(folder));
        const cOnly = '# project(fake LANGUAGES CXX)\nproject(real LANGUAGES C ASM)\nadd_executable(app main.c helper.cpp)\n';
        const mixed = mixedCMakeLanguages(cOnly);
        assert(mixed.includes('enable_language(CXX)'));
        assert(mixed.indexOf('enable_language(CXX)') < mixed.indexOf('add_executable'));
        assert.strictEqual(mixedCMakeLanguages(mixed), mixed, 'language preparation must be idempotent');
        const defaults = 'project(real)\nadd_executable(app main.c helper.cpp)';
        assert.strictEqual(mixedCMakeLanguages(defaults), defaults, 'default project already enables C and C++');
        const cppOnly = 'project(real LANGUAGES CXX)\n';
        assert(mixedCMakeLanguages(cppOnly).includes('enable_language(C)'));
        assert(mixedCMakeLanguages('project(real C ASM)').includes('enable_language(CXX)'), 'old project signatures need CXX too');
        assert.strictEqual(mixedCMakeLanguages('project(real LANGUAGES C CXX ASM)'), 'project(real LANGUAGES C CXX ASM)');
        const brackets = '#[=[project(fake LANGUAGES CXX)]=]\nproject(real LANGUAGES C)\n';
        assert(mixedCMakeLanguages(brackets).includes('enable_language(CXX)'));
        const standard = mixedCMakeCppStandard(mixed);
        assert(standard.includes('set(CMAKE_CXX_STANDARD 20)'));
        assert(standard.includes('set(CMAKE_CXX_STANDARD_REQUIRED ON)'));
        assert(standard.indexOf('set(CMAKE_CXX_STANDARD 20)') < standard.indexOf('project(real'));
        assert.strictEqual(mixedCMakeCppStandard(standard), standard, 'C++20 preparation must be idempotent');
        const oldStandard = '# set(CMAKE_CXX_STANDARD 11)\r\nset(CMAKE_C_STANDARD 11)\r\n'
            + 'set(CMAKE_CXX_STANDARD "17" CACHE STRING "C++ standard")\r\n'
            + 'set(CMAKE_CXX_STANDARD_REQUIRED OFF)\r\nproject(real LANGUAGES C CXX)\r\n';
        const upgraded = mixedCMakeCppStandard(oldStandard);
        assert(upgraded.includes('# set(CMAKE_CXX_STANDARD 11)\r\n'), 'comments remain untouched');
        assert(upgraded.includes('set(CMAKE_C_STANDARD 11)\r\n'), 'C standard remains independent');
        assert(upgraded.includes('set(CMAKE_CXX_STANDARD 20 CACHE STRING "C++ standard")\r\n'));
        assert(upgraded.includes('set(CMAKE_CXX_STANDARD_REQUIRED ON)\r\n'));
        assert.strictEqual(mixedCMakeCppStandard(upgraded), upgraded);
        const laterSetter = mixedCMakeCppStandard('project(real)\nadd_executable(app main.cpp)\nset(CMAKE_CXX_STANDARD 11)\n');
        assert(laterSetter.indexOf('set(CMAKE_CXX_STANDARD 20)') < laterSetter.indexOf('project(real)'));
        assert(!laterSetter.includes('set(CMAKE_CXX_STANDARD 11)'));
        activeDocument.fileName = 'C:/project/main.c';
        assert.strictEqual(workflow.activeStandard(), '-std=c11');
        await workflow.debug(folder);
        assert.strictEqual(launches.length, 2, 'C source must use the same desktop debug entry point');
        for (const name of ['main.c', 'util.cc', 'helper.cpp', 'unused.cxx']) {
            fs.writeFileSync(path.join(temporary, name), '');
        }
        fs.writeFileSync(path.join(temporary, 'CMakeLists.txt'), 'project(mixed LANGUAGES C CXX)\n'
            + 'add_executable(app main.c)\ntarget_sources(app PRIVATE util.cc)\n'
            + '# rm_debug BEGIN managed sources\ntarget_sources(app PRIVATE helper.cpp)\n# rm_debug END managed sources\n');
        const provider = new CMakeProjectProvider(async () => temporary, () => path.join(temporary, 'no-database.json'));
        const root = await provider.load();
        const sources = provider.getGroups()[0].sources;
        assert.strictEqual(sources.length, 3, 'C and C++ sources declared by all supported CMake forms must appear together');
        assert(sources.find((item) => path.basename(item.file) === 'helper.cpp').managed);
        const children = await provider.getChildren(root);
        assert(children.some((item) => item.label === 'unused.cxx' && !item.source), 'unlisted C++ files must remain visible as candidates');
        provider.dispose();
        console.log('C/C++ configuration, CMake tree, merge and workflow regression checks passed');
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
