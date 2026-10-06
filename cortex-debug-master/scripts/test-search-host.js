const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-search-host-'));
    const fixture = path.join(temporary, 'workspace');
    const harness = path.join(temporary, 'harness');
    const extensions = path.join(temporary, 'extensions');
    const user = path.join(temporary, 'user');
    const installed = process.env.RM_SEARCH_EXTENSIONS || path.join(os.homedir(), '.vscode/extensions');
    const cppFolder = fs.readdirSync(installed).filter((name) => /^ms-vscode\.cpptools-\d/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (!cppFolder) { throw new Error('Install Microsoft C/C++ before running this optional real-host check.'); }
    for (const directory of [harness, extensions, path.join(user, 'User'), path.join(fixture, 'alpha/.vscode'),
        path.join(fixture, 'alpha/firmware/ignored'), path.join(fixture, 'beta')]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.symlinkSync(path.join(installed, cppFolder), path.join(extensions, cppFolder), 'dir');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const contributes = packageJson.contributes;
    const commands = contributes.commands.filter((command) => command.command.startsWith('rm-debug.search'));
    const menus = Object.fromEntries(Object.entries(contributes.menus).map(([name, items]) => [name,
        items.filter((item) => item.command.startsWith('rm-debug.search'))]).filter(([, items]) => items.length));
    fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({
        name: 'rm-debug-search-smoke', publisher: 'rm-test', version: '1.0.0', engines: { vscode: '^1.92.0' },
        main: './main.js', activationEvents: ['onStartupFinished'], contributes: {
            commands, menus, viewsContainers: { activitybar: [{ id: 'rm-debug', title: 'rm_debug 搜索验收', icon: 'rm-debug.svg' }] },
            views: { 'rm-debug': contributes.views['rm-debug'].filter((view) => view.id === 'rm-debug.searchResults') }
        }
    }, null, 4));
    fs.copyFileSync(path.join(root, 'images/rm-debug.svg'), path.join(harness, 'rm-debug.svg'));
    fs.writeFileSync(path.join(harness, 'main.js'),
        `const { RmSearch } = require(${JSON.stringify(path.join(root, 'out/src/frontend/rm-search'))});\n`
        + 'exports.activate = (context) => new RmSearch(context);\n');
    fs.writeFileSync(path.join(user, 'User/settings.json'), JSON.stringify({
        'telemetry.telemetryLevel': 'off', 'security.workspace.trust.enabled': false,
        'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none'
    }));
    const files = {
        'alpha/firmware/CMakeLists.txt': 'project(fixture LANGUAGES CXX)\n',
        'alpha/firmware/defs.h': 'extern int rm_search_value;\n',
        'alpha/firmware/defs.cpp': 'int rm_search_value = 1;\n',
        'alpha/firmware/use.cpp': '#include "defs.h"\nint use_value() { return rm_search_value; }\n',
        'alpha/firmware/ignored/extra.cpp': '// rm_search_value also appears in an ignored source folder\n',
        'alpha/.gitignore': 'firmware/ignored/\n',
        'beta/unrelated.cpp': 'int other() { int rm_search_value = 2; return rm_search_value; }\n'
    };
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(fixture, name), content);
    }
    const database = ['alpha/firmware/defs.cpp', 'alpha/firmware/use.cpp', 'beta/unrelated.cpp'].map((file) => ({
        file: path.join(fixture, file), directory: path.join(fixture, path.dirname(file)),
        arguments: ['/usr/bin/g++', '-std=c++20', '-I' + path.join(fixture, 'alpha/firmware'), '-c', path.join(fixture, file)]
    }));
    fs.writeFileSync(path.join(fixture, 'compile_commands.json'), JSON.stringify(database));
    fs.writeFileSync(path.join(fixture, 'alpha/.vscode/c_cpp_properties.json'), JSON.stringify({
        version: 4, configurations: [{ name: 'test', compilerPath: '/usr/bin/g++',
            compileCommands: [path.join(fixture, 'compile_commands.json')], browse: { limitSymbolsToIncludedHeaders: false } }]
    }));
    const workspace = path.join(fixture, 'search.code-workspace');
    fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }], settings: {
        'rm-debug.projectDirectory': 'firmware', 'search.mode': 'reuseEditor'
    } }));
    console.log(`Running isolated VS Code search checks in ${temporary}`);
    try {
        await runTests({
            vscodeExecutablePath: process.env.RM_SEARCH_VSCODE || '/usr/share/code/code',
            extensionDevelopmentPath: harness, extensionTestsPath: path.join(root, 'out/test/search-extension-host.js'),
            extensionTestsEnv: { RM_SEARCH_HOST_FIXTURE: fixture },
            launchArgs: [workspace, '--user-data-dir', user, '--extensions-dir', extensions,
                '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
        });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
