import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { CMakeProjectManager, prepareMixedCMake } from './cmake-project';
import { DesktopWorkflow } from './desktop-workflow';
import { MujocoWorkflow } from './mujoco-workflow';
import { backupRelocatedCMakeCache } from './cmake-cache';
import { analyzeFlashFailure, FlashLog, formatFlashDiagnosis } from './flash-diagnostics';
import {
    armToolchainDirectory, bashPath, bashQuote, configuredBash, discoverArmGdb, executableCandidates,
    existingDirectory, existingFile, jlinkCandidates, normalizedToolPath, platformSetting, toolName, uniqueFiles
} from './rm-tools';

interface LaunchConfig {
    name?: string;
    type?: string;
    request?: string;
    servertype?: string;
    device?: string;
    interface?: string;
    cwd?: string;
    executable?: string;
    gdbPath?: string;
    armToolchainPath?: string;
    serverpath?: string;
    configFiles?: string[];
    searchDir?: string[];
    openOCDPreConfigLaunchCommands?: string[];
    openOCDLaunchCommands?: string[];
    liveWatch?: { enabled: boolean; samplesPerSecond: number };
}

interface CMakeConfigurePreset {
    name: string;
    binaryDir?: string;
    inherits?: string | string[];
}

type ProbeType = 'stlink' | 'jlink' | 'daplink';
const GENERATED_LAUNCH_NAMES = ['rm_debug: OpenOCD', 'rm_debug: ST-Link', 'rm_debug: J-Link', 'rm_debug: DAPLink'];

function launchName(probe: ProbeType): string {
    return `rm_debug: ${probe === 'jlink' ? 'J-Link' : probe === 'stlink' ? 'ST-Link' : 'DAPLink'}`;
}

function probeFromLaunch(launch: LaunchConfig | undefined): ProbeType {
    if (launch?.servertype === 'jlink') { return 'jlink'; }
    if (launch?.configFiles?.[0] === 'interface/stlink.cfg') { return 'stlink'; }
    return 'daplink';
}

function inWorkspacePath(folder: vscode.WorkspaceFolder, relative: string): string {
    return '${workspaceFolder}' + (relative ? '/' + relative.replace(/\\/g, '/') : '');
}

function expandWorkspacePath(value: string, folder: vscode.WorkspaceFolder): string {
    return value
        .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, folder.uri.fsPath)
        .replace(/\$\{workspaceFolderBasename\}/g, path.basename(folder.uri.fsPath));
}

function deviceFromIoc(project: string): string {
    const ioc = fs.readdirSync(project).find((entry) => entry.toLowerCase().endsWith('.ioc'));
    if (!ioc) { return ''; }
    const content = fs.readFileSync(path.join(project, ioc), 'utf8');
    const device = content.match(/^Mcu\.UserName=([^\r\n]+)/m)?.[1].trim()
        || content.match(/^Mcu\.Name=([^\r\n]+)/m)?.[1].trim()
        || '';
    return /^STM32[A-Z0-9]+Tx$/i.test(device) ? device.slice(0, -2) : device;
}

function targetFromIoc(project: string): string {
    const match = deviceFromIoc(project).match(/^STM32([A-Z][0-9])/i);
    return match ? `target/stm32${match[1].toLowerCase()}x.cfg` : 'target/stm32f4x.cfg';
}

function scriptsCandidates(openocd: string, configured: string): string[] {
    return [
        path.resolve(path.dirname(openocd), '..', 'share', 'openocd', 'scripts'),
        path.resolve(path.dirname(openocd), '..', 'scripts'),
        configured,
        process.env.OPENOCD_SCRIPTS || ''
    ].filter(existingDirectory);
}

function configAvailable(scripts: string, config: string): boolean {
    if (!scripts || !config) { return false; }
    const filename = config.replace(/\//g, path.sep);
    return existingFile(path.isAbsolute(filename) ? filename : path.join(scripts, filename));
}

function toolRoot(executable: string): string {
    return normalizedToolPath(path.dirname(path.dirname(executable)));
}

function preferredExecutable(candidates: string[], companion: string): string {
    return candidates.find((item) => toolRoot(item) === toolRoot(companion)) || candidates[0] || '';
}

class WorkflowTree implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly status: () => string) { }

    refresh(): void { this.changed.fire(undefined); }
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
    getChildren(): vscode.TreeItem[] {
        const items: Array<[string, string, string]> = [
            ['配置工程和工具路径', 'rm-debug.configure', 'gear'],
            ['配置桌面 C/C++', 'rm-debug.desktop.configure', 'device-desktop'],
            ['配置 MuJoCo 仿真', 'rm-debug.mujoco.configure', 'gear'],
            ['MuJoCo 编译 C++', 'rm-debug.mujoco.build', 'tools'],
            ['MuJoCo 窗口调试', 'rm-debug.mujoco.debug', 'debug-start'],
            ['MuJoCo 无窗口调试', 'rm-debug.mujoco.headless', 'debug-alt'],
            ['编译 Build', 'rm-debug.build', 'tools'],
            ['烧录 Flash', 'rm-debug.flash', 'cloud-upload'],
            ['调试 Debug', 'rm-debug.debug', 'debug-start'],
            ['变量搜索（范围 / 定义 / 引用）', 'rm-debug.search', 'search']
        ];
        return items.map(([label, command, icon]) => {
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.command = { command, title: label };
            item.iconPath = new vscode.ThemeIcon(icon);
            if (command === 'rm-debug.build') { item.description = this.status(); }
            return item;
        });
    }
}

export class RmWorkflow implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('rm_debug');
    private readonly desktop = new DesktopWorkflow(this.output);
    private readonly mujoco = new MujocoWorkflow(this.output);
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('rm_debug Build');
    private readonly tree = new WorkflowTree(() => this.state);
    private state = '就绪';
    private busy = false;
    private currentProcess: ReturnType<typeof spawn> | undefined;
    private readonly failedBuildProjects = new Set<string>();
    private readonly failedFlashProjects = new Set<string>();
    private errorCount = 0;
    private warningCount = 0;

    constructor(context: vscode.ExtensionContext) {
        new CMakeProjectManager(
            context,
            () => this.cmakeProjectDirectory(),
            (project) => this.cmakeCompileCommandsFile(project)
        );
        context.subscriptions.push(
            this,
            this.output,
            this.diagnostics,
            vscode.window.createTreeView('rm-debug.workflow', { treeDataProvider: this.tree }),
            vscode.commands.registerCommand('rm-debug.configure', () => this.configure()),
            vscode.commands.registerCommand('rm-debug.desktop.configure', async () => {
                const folder = await this.workspaceFolder();
                if (folder) { await this.desktop.configure(folder); }
            }),
            vscode.commands.registerCommand('rm-debug.desktop.compiler', () => this.desktop.activeCompiler()),
            vscode.commands.registerCommand('rm-debug.desktop.standard', () => this.desktop.activeStandard()),
            ...(['configure', 'build', 'debug', 'headless'] as const).map((action) =>
                vscode.commands.registerCommand(`rm-debug.mujoco.${action}`, async () => {
                    if (this.busy) {
                        void vscode.window.showWarningMessage('rm_debug：请等待当前命令结束。');
                        return;
                    }
                    const folder = await this.workspaceFolder();
                    if (!folder) { return; }
                    if (action === 'headless') {
                        await this.mujoco.debug(folder, true);
                    } else {
                        await this.mujoco[action](folder);
                    }
                })),
            vscode.commands.registerCommand('rm-debug.build', () => this.build()),
            vscode.commands.registerCommand('rm-debug.flash', () => this.flash()),
            vscode.commands.registerCommand('rm-debug.debug', () => this.debug())
        );
    }

    dispose(): void {
        this.currentProcess?.kill();
    }

    private setState(value: string): void {
        this.state = value;
        this.tree.refresh();
    }

    private async workspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0) {
            vscode.window.showErrorMessage('rm_debug：请先在 VS Code 打开一个工程文件夹。');
            return undefined;
        }
        if (folders.length === 1) { return folders[0]; }
        const choice = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), {
            placeHolder: '选择要编译或烧录的工程'
        });
        return choice?.folder;
    }

    private async cmakeProjectDirectory(): Promise<string | undefined> {
        const folder = await this.workspaceFolder();
        if (folder && this.mujoco.isEnabled(folder)) {
            const source = vscode.workspace.getConfiguration('rm-debug', folder.uri)
                .get<string>('mujoco.sourceDirectory', 'parallel_controller_mujoco/native');
            const directory = path.resolve(folder.uri.fsPath, source);
            if (existingFile(path.join(directory, 'CMakeLists.txt'))) { return directory; }
        }
        return folder ? this.projectDirectory(folder) : undefined;
    }

    private cmakeCompileCommandsFile(project: string): string {
        const folder = (vscode.workspace.workspaceFolders || []).find((candidate) => {
            const relative = path.relative(candidate.uri.fsPath, project);
            return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        });
        if (folder && this.mujoco.isEnabled(folder)) {
            const build = vscode.workspace.getConfiguration('rm-debug', folder.uri)
                .get<string>('mujoco.buildDirectory', 'parallel_controller_mujoco/build/native');
            return path.resolve(folder.uri.fsPath, build, 'compile_commands.json');
        }
        if (folder && this.desktop.isEnabled(folder)) {
            const directory = vscode.workspace.getConfiguration('rm-debug', folder.uri)
                .get<string>('desktop.buildDirectory', 'build/rm-desktop-gdb');
            return path.resolve(project, directory, 'compile_commands.json');
        }
        const preset = folder ? vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>('buildPreset', 'Debug') : 'Debug';
        return path.join(this.buildDirectory(project, preset), 'compile_commands.json');
    }

    private projectCandidates(folder: vscode.WorkspaceFolder): string[] {
        const root = folder.uri.fsPath;
        const result: string[] = [];
        if (existingFile(path.join(root, 'CMakeLists.txt'))) { result.push(root); }
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && existingFile(path.join(root, entry.name, 'CMakeLists.txt'))) {
                result.push(path.join(root, entry.name));
            }
        }
        return result;
    }

    private async projectDirectory(folder: vscode.WorkspaceFolder, pick = false): Promise<string | undefined> {
        const configured = vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>('projectDirectory', '');
        const configuredPath = path.resolve(folder.uri.fsPath, configured);
        if (!pick && existingFile(path.join(configuredPath, 'CMakeLists.txt'))) { return configuredPath; }
        const candidates = this.projectCandidates(folder);
        if (candidates.length === 1) { return candidates[0]; }
        const choice = await vscode.window.showQuickPick(candidates.map((candidate) => ({
            label: path.relative(folder.uri.fsPath, candidate) || '.', directory: candidate
        })), { placeHolder: '选择包含 CMakeLists.txt 的工程目录' });
        if (!choice) { vscode.window.showErrorMessage('rm_debug：未找到 CMakeLists.txt，请打开 CMake 工程目录。'); }
        return choice?.directory;
    }

    private launchConfigurations(folder: vscode.WorkspaceFolder): LaunchConfig[] {
        return vscode.workspace.getConfiguration('launch', folder.uri).get<LaunchConfig[]>('configurations', []);
    }

    private workflowLaunch(folder: vscode.WorkspaceFolder): LaunchConfig | undefined {
        const configs = this.launchConfigurations(folder);
        return configs.find((item) => GENERATED_LAUNCH_NAMES.includes(item.name || ''))
            || configs.find((item) => item.type === 'cortex-debug' && ['openocd', 'jlink'].includes(item.servertype || ''));
    }

    private async locateMissing(label: string, directory = false): Promise<string | undefined> {
        const action = await vscode.window.showWarningMessage(
            `rm_debug：未自动找到 ${label}，请选择其${directory ? '目录' : '可执行文件'}。`, '浏览…'
        );
        if (action !== '浏览…') { return undefined; }
        const selected = await vscode.window.showOpenDialog({
            title: `rm_debug：选择 ${label}`,
            canSelectFiles: !directory,
            canSelectFolders: directory,
            canSelectMany: false
        });
        return selected?.[0]?.fsPath;
    }

    private discoverGdb(bash: string, gcc: string): string {
        const saved = vscode.workspace.getConfiguration('rm-debug').get<string>('armGdbPath', '');
        return discoverArmGdb(bash, gcc, saved);
    }

    private async saveGdbSettings(gdb: string): Promise<void> {
        const machine = vscode.workspace.getConfiguration('rm-debug');
        const debuggerSettings = vscode.workspace.getConfiguration('cortex-debug');
        const global = vscode.ConfigurationTarget.Global;
        if (machine.get<string>('armGdbPath', '') !== gdb) {
            await machine.update('armGdbPath', gdb, global);
        }
        if (debuggerSettings.get<string>(`gdbPath.${platformSetting()}`, '') !== gdb) {
            await debuggerSettings.update(`gdbPath.${platformSetting()}`, gdb, global);
        }
        const toolchain = armToolchainDirectory(machine.get<string>('armGccPath', ''), gdb);
        if (debuggerSettings.get<string>(`armToolchainPath.${platformSetting()}`, '') !== toolchain) {
            await debuggerSettings.update(`armToolchainPath.${platformSetting()}`, toolchain, global);
        }
    }

    private buildDirectory(project: string, preset: string): string {
        const presetFile = path.join(project, 'CMakePresets.json');
        if (!existingFile(presetFile)) { return path.join(project, 'build'); }
        try {
            const parsed = JSON.parse(fs.readFileSync(presetFile, 'utf8')) as {
                configurePresets?: CMakeConfigurePreset[];
                buildPresets?: Array<{ name: string; configurePreset?: string }>;
            };
            const configurePresets = parsed.configurePresets || [];
            const buildPreset = (parsed.buildPresets || []).find((item) => item.name === preset);
            const configureName = buildPreset?.configurePreset || preset;
            const findBinaryDir = (name: string, visited = new Set<string>()): string => {
                if (visited.has(name)) { return ''; }
                visited.add(name);
                const item = configurePresets.find((candidate) => candidate.name === name);
                if (!item) { return ''; }
                if (item.binaryDir) { return item.binaryDir; }
                const parents = Array.isArray(item.inherits) ? item.inherits : item.inherits ? [item.inherits] : [];
                for (const parent of parents) {
                    const inherited = findBinaryDir(parent, visited);
                    if (inherited) { return inherited; }
                }
                return '';
            };
            const template = findBinaryDir(configureName);
            if (template) {
                const expanded = template
                    .replace(/\$\{sourceDir\}/g, project.replace(/\\/g, '/'))
                    .replace(/\$\{sourceParentDir\}/g, path.dirname(project).replace(/\\/g, '/'))
                    .replace(/\$\{sourceDirName\}/g, path.basename(project))
                    .replace(/\$\{presetName\}/g, configureName);
                if (!/\$\{|\$env\{|\$penv\{/.test(expanded)) { return path.resolve(project, expanded); }
            }
        } catch (_error) { /* Fall back to the usual CMake preset directory. */ }
        return path.join(project, 'build', preset);
    }

    private projectDefines(project: string, compileCommands: string, preset: string): string[] {
        const defines = new Set<string>();
        if (existingFile(compileCommands)) {
            try {
                const entries = JSON.parse(fs.readFileSync(compileCommands, 'utf8')) as Array<{ command?: string; arguments?: string[] }>;
                for (const entry of entries.slice(0, 20)) {
                    const command = entry.command || entry.arguments?.join(' ') || '';
                    for (const match of command.matchAll(/(?:^|\s)-D([A-Za-z_]\w*(?:=[^\s"]+)?)\b/g)) {
                        defines.add(match[1]);
                    }
                }
            } catch (_error) { /* CubeMX definitions remain available below. */ }
        }
        const cubeCmake = path.join(project, 'cmake', 'stm32cubemx', 'CMakeLists.txt');
        if (existingFile(cubeCmake)) {
            const content = fs.readFileSync(cubeCmake, 'utf8');
            for (const match of content.matchAll(/\b(?:USE_HAL_DRIVER|STM32[A-Za-z0-9]+x[A-Za-z0-9]+)\b/g)) {
                defines.add(match[0]);
            }
        }
        if (/^debug$/i.test(preset)) { defines.add('DEBUG'); }
        return [...defines];
    }

    private projectCStandard(project: string): string {
        const cmake = path.join(project, 'CMakeLists.txt');
        if (existingFile(cmake)) {
            const match = fs.readFileSync(cmake, 'utf8').match(/set\s*\(\s*CMAKE_C_STANDARD\s+(90|99|11|17|23)\s*\)/i);
            if (match) { return match[1] === '90' ? 'c89' : `c${match[1]}`; }
        }
        return 'c11';
    }

    private async saveClangdSettings(gcc: string, compileCommands: string): Promise<void> {
        const compilers = [gcc];
        if (existingFile(compileCommands)) {
            try {
                const entries = JSON.parse(fs.readFileSync(compileCommands, 'utf8')) as Array<{ command?: string; arguments?: string[] }>;
                for (const entry of entries.slice(0, 20)) {
                    const first = entry.arguments?.[0] || entry.command?.trim().match(/^(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean);
                    if (first && existingFile(first)) { compilers.push(first); }
                }
            } catch (_error) { /* The discovered ARM GCC remains available. */ }
        }
        const patterns = [...new Set(compilers.map((compiler) =>
            path.join(path.dirname(compiler), toolName('arm-none-eabi-*')).replace(/\\/g, '/')))];
        for (const [extensionId, section] of [
            ['llvm-vs-code-extensions.vscode-clangd', 'clangd'],
            ['STMicroelectronics.stm32cube-ide-clangd', 'stm32cube-ide-clangd']
        ]) {
            if (!vscode.extensions.getExtension(extensionId)) { continue; }
            const setting = vscode.workspace.getConfiguration(section);
            const current = setting.inspect<string[]>('arguments')?.globalValue || [];
            const other = current.filter((argument) => !argument.startsWith('--query-driver='));
            const previous = current.filter((argument) => argument.startsWith('--query-driver='))
                .flatMap((argument) => argument.slice('--query-driver='.length).split(','));
            const next = [...other, `--query-driver=${[...new Set([...previous, ...patterns])].join(',')}`];
            if (JSON.stringify(next) !== JSON.stringify(current)) {
                await setting.update('arguments', next, vscode.ConfigurationTarget.Global);
            }
        }
    }

    private writeClangdConfig(project: string, binaryDir: string): void {
        const target = path.join(project, '.clangd');
        const relative = path.relative(project, binaryDir).replace(/\\/g, '/') || '.';
        const directory = path.isAbsolute(relative) ? binaryDir.replace(/\\/g, '/') : relative;
        const begin = '# rm_debug compilation database begin';
        const end = '# rm_debug compilation database end';
        const managed = `${begin}\n---\nCompileFlags:\n  CompilationDatabase: ${JSON.stringify(directory)}\n${end}\n`;
        const current = existingFile(target) ? fs.readFileSync(target, 'utf8') : '';
        const start = current.indexOf(begin);
        const finish = current.indexOf(end);
        if ((start < 0) !== (finish < 0)) {
            throw new Error('已有 .clangd 中的 rm_debug 标记不完整，请先修复该文件。');
        }
        const next = start >= 0
            ? current.slice(0, start) + managed + current.slice(finish + end.length).replace(/^\r?\n/, '')
            : (current ? current.replace(/\s*$/, '\n') : '') + managed;
        if (next !== current) { fs.writeFileSync(target, next, 'utf8'); }
    }

    private writeCppProperties(folder: vscode.WorkspaceFolder, project: string, compileCommands: string, preset: string): void {
        const target = path.join(folder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
        const projectFile = path.join(project, '.vscode', 'c_cpp_properties.json');
        const source = existingFile(target) ? target : projectFile;
        let content = existingFile(source)
            ? fs.readFileSync(source, 'utf8')
            : JSON.stringify({ version: 4, configurations: [{ name: 'rm_debug', includePath: ['${workspaceFolder}/**'] }] }, null, 4);
        const parsed = parse(content);
        if (!parsed || !Array.isArray(parsed.configurations)) {
            throw new Error('已有 c_cpp_properties.json 格式无效，请先修复该文件。');
        }
        const defines = this.projectDefines(project, expandWorkspacePath(compileCommands, folder), preset);
        for (let index = 0; index < parsed.configurations.length; index++) {
            const formattingOptions = { insertSpaces: true, tabSize: 4 };
            const existingConfig = parsed.configurations[index];
            content = applyEdits(content, modify(content, ['configurations', index, 'compilerPath'], undefined, { formattingOptions }));
            content = applyEdits(content, modify(content, ['configurations', index, 'compileCommands'], [compileCommands], { formattingOptions }));
            content = applyEdits(content, modify(content, ['configurations', index, 'intelliSenseMode'], 'gcc-arm', { formattingOptions }));
            const cStandard = typeof existingConfig.cStandard === 'string'
                ? existingConfig.cStandard
                : this.projectCStandard(project);
            content = applyEdits(content, modify(content, ['configurations', index, 'cStandard'], cStandard, { formattingOptions }));
            content = applyEdits(content, modify(content, ['configurations', index, 'cppStandard'], 'c++20', { formattingOptions }));
            const existing = Array.isArray(existingConfig.defines)
                ? existingConfig.defines.filter((value: unknown): value is string => typeof value === 'string')
                : [];
            const merged = [...new Set([...existing, ...defines])];
            content = applyEdits(content, modify(content, ['configurations', index, 'defines'], merged, { formattingOptions }));
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content.endsWith('\n') ? content : content + '\n', 'utf8');
    }

    private async configure(): Promise<void> {
        const folder = await this.workspaceFolder();
        if (!folder) { return; }
        const target = await vscode.window.showQuickPick([
            { label: 'STM32 / ARM 嵌入式工程', target: 'embedded' },
            { label: '桌面 C/C++ 程序', target: 'desktop' },
            { label: 'MuJoCo 仿真 C++', target: 'mujoco' }
        ], { title: 'rm_debug：选择工程类型' });
        if (!target) { return; }
        if (target.target === 'mujoco') {
            await this.mujoco.configure(folder);
            return;
        }
        if (target.target === 'desktop') {
            await this.desktop.configure(folder);
            return;
        }
        const project = await this.projectDirectory(folder, true);
        if (!project) { return; }
        const machine = vscode.workspace.getConfiguration('rm-debug');
        const presetFile = path.join(project, 'CMakePresets.json');
        let presets = ['Debug'];
        if (existingFile(presetFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
                presets = (parsed.buildPresets || parsed.configurePresets || [])
                    .filter((item: { name?: string; hidden?: boolean }) => item.name && !item.hidden)
                    .map((item: { name: string }) => item.name);
            } catch (_error) { /* Manual preset entry remains available. */ }
        }
        const config = vscode.workspace.getConfiguration('rm-debug', folder.uri);
        const selectedPreset = await vscode.window.showQuickPick(presets.length ? presets : ['Debug'], {
            placeHolder: '选择 CMake preset'
        });
        if (!selectedPreset) { return; }
        const existing = this.workflowLaunch(folder);
        const cmakeName = fs.readFileSync(path.join(project, 'CMakeLists.txt'), 'utf8')
            .match(/set\s*\(\s*CMAKE_PROJECT_NAME\s+([\w.-]+)/)?.[1]
            || fs.readFileSync(path.join(project, 'CMakeLists.txt'), 'utf8').match(/project\s*\(\s*([\w.-]+)/)?.[1]
            || path.basename(project);
        const firmwareDefault = config.get('firmwarePath', '') || `build/${selectedPreset}/${cmakeName}.elf`;
        const firmware = await vscode.window.showInputBox({
            title: 'rm_debug：ELF 文件', value: firmwareDefault, prompt: '相对于 CMake 工程目录的 ELF 路径'
        });
        if (firmware === undefined || !firmware.trim()) { return; }
        const probeSetting = config.inspect<ProbeType>('probeType');
        const currentProbe = probeSetting?.workspaceFolderValue || probeSetting?.workspaceValue || probeFromLaunch(existing);
        const probeOptions: Array<{ label: string; description: string; value: ProbeType }> = [
            { label: 'ST-Link', description: 'OpenOCD · interface/stlink.cfg', value: 'stlink' },
            { label: 'J-Link', description: 'SEGGER J-Link GDB Server · 不使用 OpenOCD', value: 'jlink' },
            { label: 'DAPLink', description: 'OpenOCD · interface/cmsis-dap.cfg', value: 'daplink' }
        ];
        probeOptions.sort((left, right) => Number(right.value === currentProbe) - Number(left.value === currentProbe));
        const probeChoice = await vscode.window.showQuickPick(probeOptions, {
            title: 'rm_debug：选择调试器', placeHolder: '选择连接到芯片的探针'
        });
        if (!probeChoice) { return; }
        const probe = probeChoice.value;
        const interfaceConfig = probe === 'stlink' ? 'interface/stlink.cfg' : 'interface/cmsis-dap.cfg';
        let targetConfig = '';
        let jlinkDevice = '';
        if (probe === 'jlink') {
            const entered = await vscode.window.showInputBox({
                title: 'rm_debug：J-Link 芯片型号',
                value: config.get('jlinkDevice', '') || existing?.device || deviceFromIoc(project),
                prompt: '例如 STM32F103C8；已从 CubeMX .ioc 自动读取时请核对',
                validateInput: (value) => /^[A-Za-z0-9_.-]+$/.test(value.trim())
                    ? undefined
                    : '请输入 SEGGER 支持的芯片型号（仅字母、数字、点、下划线或连字符）'
            });
            if (entered === undefined) { return; }
            jlinkDevice = entered.trim();
        } else {
            const entered = await vscode.window.showInputBox({
                title: 'rm_debug：OpenOCD 芯片配置',
                value: config.get('targetConfig', '') || existing?.configFiles?.[1] || targetFromIoc(project),
                prompt: '例如 target/stm32f1x.cfg；按实际芯片填写'
            });
            if (entered === undefined || !entered.trim()) { return; }
            targetConfig = entered.trim();
        }

        const bash = configuredBash(machine)
            || await this.locateMissing(process.platform === 'win32' ? 'Git Bash bash.exe' : 'Bash（/bin/bash）');
        if (!bash || !existingFile(bash)) { return; }

        let openocd = '';
        let scripts = '';
        let jlinkServer = '';
        let jlinkCommander = '';
        if (probe === 'jlink') {
            jlinkServer = uniqueFiles([
                machine.get<string>('jlinkGdbServerPath', ''), ...jlinkCandidates(toolName('JLinkGDBServerCL'), bash),
                ...(process.platform !== 'win32'
                    ? [...jlinkCandidates('JLinkGDBServerCL', bash), ...jlinkCandidates('JLinkGDBServer', bash)]
                    : [])
            ])[0] || await this.locateMissing(toolName('JLinkGDBServerCL')) || '';
            if (!existingFile(jlinkServer)) { return; }
            jlinkCommander = uniqueFiles([
                machine.get<string>('jlinkCommanderPath', ''),
                path.join(path.dirname(jlinkServer), toolName('JLink')),
                ...jlinkCandidates(toolName('JLink'), bash)
            ])[0] || await this.locateMissing(toolName('JLink')) || '';
            if (!existingFile(jlinkCommander)) { return; }
        } else {
            const savedOpenocd = machine.get<string>('openocdPath', '');
            const savedScripts = machine.get<string>('openocdScriptsPath', '');
            const openocdOptions = uniqueFiles([
                ...executableCandidates(toolName('openocd'), bash), savedOpenocd
            ]).map((executable) => {
                const scriptsForExecutable = scriptsCandidates(executable, savedScripts)
                    .sort((left, right) =>
                        Number(configAvailable(right, interfaceConfig)) + Number(configAvailable(right, targetConfig))
                        - Number(configAvailable(left, interfaceConfig)) - Number(configAvailable(left, targetConfig)))[0] || '';
                const score = 2 * (Number(configAvailable(scriptsForExecutable, interfaceConfig))
                    + Number(configAvailable(scriptsForExecutable, targetConfig)))
                    + Number(normalizedToolPath(scriptsForExecutable).startsWith(toolRoot(executable) + path.sep));
                return { executable, scripts: scriptsForExecutable, score };
            }).sort((left, right) => right.score - left.score);
            const selectedOpenocd = openocdOptions[0];
            openocd = selectedOpenocd?.executable || await this.locateMissing(toolName('openocd')) || '';
            if (!existingFile(openocd)) { return; }
            scripts = selectedOpenocd?.scripts || scriptsCandidates(openocd, savedScripts)[0] || '';
            if (!scripts || !configAvailable(scripts, interfaceConfig) || !configAvailable(scripts, targetConfig)) {
                scripts = await this.locateMissing('包含所选 interface/target 配置的 OpenOCD scripts', true) || '';
            }
            if (!existingDirectory(scripts)) { return; }
            if (!configAvailable(scripts, interfaceConfig) || !configAvailable(scripts, targetConfig)) {
                vscode.window.showErrorMessage('rm_debug：所选 OpenOCD scripts 目录缺少 interface 或 target 配置文件。');
                return;
            }
        }

        const gcc = (existingFile(machine.get('armGccPath', '')) && machine.get<string>('armGccPath', ''))
            || preferredExecutable(executableCandidates(toolName('arm-none-eabi-gcc'), bash), openocd || jlinkServer)
            || await this.locateMissing(toolName('arm-none-eabi-gcc'));
        if (!gcc || !existingFile(gcc)) { return; }
        const gdb = this.discoverGdb(bash, gcc) || await this.locateMissing(toolName('arm-none-eabi-gdb'));
        if (!gdb || !existingFile(gdb)) { return; }
        const cmake = (existingFile(machine.get('cmakePath', '')) && machine.get<string>('cmakePath', ''))
            || preferredExecutable(executableCandidates(toolName('cmake'), bash), openocd || jlinkServer)
            || await this.locateMissing(toolName('cmake'));
        if (!cmake || !existingFile(cmake)) { return; }
        const ninja = (existingFile(machine.get('ninjaPath', '')) && machine.get<string>('ninjaPath', ''))
            || preferredExecutable(executableCandidates(toolName('ninja'), bash), openocd || jlinkServer);

        this.output.appendLine('自动发现的本机工具：');
        for (const [label, value] of [
            ['探针', probeChoice.label], ['Bash', bash], ['ARM GCC', gcc], ['ARM GDB', gdb],
            ...(probe === 'jlink'
                ? [['J-Link GDB Server', jlinkServer], ['J-Link Commander', jlinkCommander]]
                : [['OpenOCD', openocd], ['OpenOCD scripts', scripts]]),
            ['CMake', cmake], ['Ninja', ninja || '未找到']
        ]) { this.output.appendLine(`${label}: ${value}`); }

        const global = vscode.ConfigurationTarget.Global;
        const workspace = vscode.ConfigurationTarget.WorkspaceFolder;
        await machine.update(process.platform === 'win32' ? 'gitBashPath' : 'bashPath', bash, global);
        await machine.update('armGccPath', gcc, global);
        if (probe === 'jlink') {
            await machine.update('jlinkGdbServerPath', jlinkServer, global);
            await machine.update('jlinkCommanderPath', jlinkCommander, global);
        } else {
            await machine.update('openocdPath', openocd, global);
            await machine.update('openocdScriptsPath', scripts, global);
            await vscode.workspace.getConfiguration('cortex-debug').update(`openocdPath.${platformSetting()}`, openocd, global);
        }
        await machine.update('cmakePath', cmake, global);
        await machine.update('ninjaPath', ninja, global);
        await this.saveGdbSettings(gdb);
        try {
            await vscode.workspace.getConfiguration('C_Cpp.default').update('compilerPath', gcc, global);
        } catch (_error) { /* C/C++ extension may not be installed yet. */ }

        const relativeProject = path.relative(folder.uri.fsPath, project).replace(/\\/g, '/');
        await config.update('projectDirectory', relativeProject, workspace);
        await config.update('buildPreset', selectedPreset, workspace);
        await config.update('firmwarePath', firmware, workspace);
        await config.update('probeType', probe, workspace);
        if (probe === 'jlink') {
            await config.update('jlinkDevice', jlinkDevice, workspace);
        } else {
            await config.update('interfaceConfig', interfaceConfig, workspace);
            await config.update('targetConfig', targetConfig, workspace);
        }
        const relativeFirmware = path.join(relativeProject, firmware).replace(/\\/g, '/');
        const dapF1 = probe === 'daplink' && /(^|[\\/])stm32f1x\.cfg$/i.test(targetConfig);
        if (dapF1) {
            this.output.appendLine('STM32F1 DAPLink: compatible flash writes; CMSIS-DAP backend auto (USB bulk preferred)');
        }
        const generated: LaunchConfig = {
            name: launchName(probe),
            type: 'cortex-debug',
            request: 'launch',
            servertype: probe === 'jlink'
                ? 'jlink'
                : 'openocd',
            cwd: inWorkspacePath(folder, relativeProject),
            executable: inWorkspacePath(folder, relativeFirmware),
            gdbPath: '${config:rm-debug.armGdbPath}',
            ...(probe === 'jlink'
                ? {
                        serverpath: '${config:rm-debug.jlinkGdbServerPath}',
                        device: jlinkDevice, interface: 'swd'
                    }
                : {
                        serverpath: '${config:rm-debug.openocdPath}',
                        configFiles: [interfaceConfig, targetConfig],
                        searchDir: ['${config:rm-debug.openocdScriptsPath}'],
                        ...(dapF1
                            ? { openOCDPreConfigLaunchCommands: ['set WORKAREASIZE 0'] }
                            : {})
                    }),
            liveWatch: { enabled: true, samplesPerSecond: 4 }
        };
        const launch = vscode.workspace.getConfiguration('launch', folder.uri);
        const next = this.launchConfigurations(folder).filter((item) => !GENERATED_LAUNCH_NAMES.includes(item.name || ''));
        next.push(generated);
        await launch.update('configurations', next, workspace);
        const binaryDir = this.buildDirectory(project, selectedPreset);
        const databaseFile = path.join(binaryDir, 'compile_commands.json');
        const compileCommands = inWorkspacePath(folder, path.relative(folder.uri.fsPath, databaseFile));
        try {
            await prepareMixedCMake(project);
            this.writeCppProperties(folder, project, compileCommands, selectedPreset);
            this.writeClangdConfig(project, binaryDir);
        } catch (error) {
            vscode.window.showWarningMessage(`rm_debug：调试和构建配置已保存，但代码检查配置未更新：${String(error)}`);
        }
        try {
            await this.saveClangdSettings(gcc, databaseFile);
        } catch (error) {
            vscode.window.showWarningMessage(`rm_debug：clangd 的 ARM GCC 系统头文件设置未更新：${String(error)}`);
        }
        vscode.window.showInformationMessage('rm_debug：配置已保存。工程参数写入 .vscode，电脑上的工具路径写入 VS Code 用户设置。');
        await vscode.workspace.getConfiguration('rm-debug', folder.uri).update('target', 'embedded', vscode.ConfigurationTarget.WorkspaceFolder);
    }

    private toolDirectories(): string[] {
        const settings = vscode.workspace.getConfiguration('rm-debug');
        return ['armGccPath', 'openocdPath', 'jlinkGdbServerPath', 'jlinkCommanderPath', 'cmakePath', 'ninjaPath']
            .map((key) => settings.get<string>(key, ''))
            .filter((value) => existingFile(value))
            .map((value) => path.dirname(value));
    }

    private environment(): NodeJS.ProcessEnv {
        return { ...process.env, PATH: [...this.toolDirectories(), process.env.PATH || ''].join(path.delimiter) };
    }

    private async runBash(
        command: string, cwd: string, token: vscode.CancellationToken, parseDiagnostics: boolean, capture?: (text: string) => void
    ): Promise<number> {
        const bash = configuredBash(vscode.workspace.getConfiguration('rm-debug'));
        if (!bash) { throw new Error('找不到 Bash。请先执行“rm_debug: Configure Workspace”配置 Bash 路径。'); }
        const directories = this.toolDirectories().map((item) => bashQuote(bashPath(item)));
        const pathPrefix = directories.length ? `export PATH=${directories.join(':')}:$PATH; ` : '';
        this.output.appendLine(`\n> ${command}\n工作目录：${cwd}`);
        return new Promise<number>((resolve, reject) => {
            const child = spawn(bash, ['-lc', pathPrefix + command], { cwd, env: this.environment(), windowsHide: true });
            this.currentProcess = child;
            let stdout = '';
            let stderr = '';
            const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
            const consume = (text: string, stream: 'stdout' | 'stderr') => {
                this.output.append(text);
                capture?.(text);
                const buffer = (stream === 'stdout' ? stdout : stderr) + text;
                const lines = buffer.split(/\r?\n|\r/);
                const tail = lines.pop() || '';
                if (stream === 'stdout') {
                    stdout = tail;
                } else {
                    stderr = tail;
                }
                if (parseDiagnostics) {
                    for (const line of lines) {
                        this.addDiagnostic(line, cwd);
                    }
                }
            };
            child.stdout?.on('data', (chunk: Buffer) => consume(decoders.stdout.write(chunk), 'stdout'));
            child.stderr?.on('data', (chunk: Buffer) => consume(decoders.stderr.write(chunk), 'stderr'));
            const cancellation = token.onCancellationRequested(() => child.kill());
            child.on('error', (error) => {
                cancellation.dispose();
                this.currentProcess = undefined;
                reject(error);
            });
            child.on('close', (code) => {
                cancellation.dispose();
                this.currentProcess = undefined;
                consume(decoders.stdout.end(), 'stdout');
                consume(decoders.stderr.end(), 'stderr');
                if (parseDiagnostics) {
                    if (stdout) { this.addDiagnostic(stdout, cwd); }
                    if (stderr) { this.addDiagnostic(stderr, cwd); }
                }
                resolve(code ?? -1);
            });
        });
    }

    private addDiagnostic(raw: string, cwd: string): void {
        const line = raw.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
        const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning):\s*(.+)$/i);
        const cmakeMatch = line.match(/^CMake (Error|Warning)(?: \(dev\))? at (.+):(\d+) \([^)]+\):/i);
        if (!match && !cmakeMatch) { return; }
        let filename = match ? match[1] : cmakeMatch[2];
        if (!path.isAbsolute(filename)) { filename = path.resolve(cwd, filename); }
        const uri = vscode.Uri.file(filename);
        const position = new vscode.Position(
            Math.max(0, Number(match ? match[2] : cmakeMatch[3]) - 1), Math.max(0, Number(match?.[3] || 1) - 1)
        );
        const isWarning = (match ? match[4] : cmakeMatch[1]).toLowerCase() === 'warning';
        const severity = isWarning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(position, position), match ? match[5] : line, severity);
        diagnostic.source = 'rm_debug Build';
        this.diagnostics.set(uri, [...(this.diagnostics.get(uri) || []), diagnostic]);
        if (isWarning) {
            this.warningCount++;
        } else {
            this.errorCount++;
        }
    }

    private async build(): Promise<void> {
        if (this.busy) {
            vscode.window.showWarningMessage('rm_debug：已有命令正在运行。');
            return;
        }
        const folder = await this.workspaceFolder();
        if (!folder) { return; }
        if (this.mujoco.isEnabled(folder)) {
            await this.mujoco.build(folder);
            return;
        }
        if (this.desktop.isEnabled(folder)) {
            await this.desktop.build(folder);
            return;
        }
        const project = await this.projectDirectory(folder);
        if (!project) { return; }
        if (vscode.debug.activeDebugSession?.type === 'cortex-debug') {
            vscode.window.showWarningMessage('rm_debug：请先结束当前调试会话，再编译。');
            return;
        }
        const config = vscode.workspace.getConfiguration('rm-debug', folder.uri);
        const preset = config.get<string>('buildPreset', 'Debug');
        const cmake = vscode.workspace.getConfiguration('rm-debug').get<string>('cmakePath', '');
        const cmakeCommand = cmake ? bashQuote(bashPath(cmake)) : 'cmake';
        const hasPresets = existingFile(path.join(project, 'CMakePresets.json'));
        const customConfigure = config.get<string>('configureCommand', '');
        const configure = customConfigure || (hasPresets
            ? `${cmakeCommand} --preset ${bashQuote(preset)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
            : `${cmakeCommand} -S . -B build -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`);
        const build = config.get<string>('buildCommand', '') || (hasPresets
            ? `${cmakeCommand} --build --preset ${bashQuote(preset)}`
            : `${cmakeCommand} --build build`);
        this.busy = true;
        this.diagnostics.clear();
        this.errorCount = 0;
        this.warningCount = 0;
        this.output.clear();
        this.output.show(true);
        this.setState('编译中');
        const started = Date.now();
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: 'rm_debug：编译', cancellable: true
            }, async (_progress, token) => {
                if (!customConfigure) {
                    const backup = backupRelocatedCMakeCache(project, this.buildDirectory(project, preset));
                    if (backup) {
                        this.output.appendLine(`检测到迁移前的 CMake 缓存：${backup.previousProject || backup.previousBuildDirectory}`);
                        this.output.appendLine(`旧 CMakeCache.txt / CMakeFiles 已备份到 ${backup.directory}，正在按本机环境重新配置。`);
                    }
                }
                await prepareMixedCMake(project);
                const configureExit = await this.runBash(configure, project, token, true);
                if (configureExit !== 0) { throw new Error(`CMake 配置失败，退出码 ${configureExit}`); }
                if (token.isCancellationRequested) { throw new Error('编译已取消'); }
                const buildExit = await this.runBash(build, project, token, true);
                if (buildExit !== 0) { throw new Error(`编译失败，退出码 ${buildExit}`); }
            });
            this.failedBuildProjects.delete(project);
            this.setState('编译成功');
            const summary = `错误 ${this.errorCount} 条，警告 ${this.warningCount} 条`;
            this.output.appendLine(`\n编译成功，${summary}，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
            if (this.errorCount + this.warningCount > 0) {
                // Keep VS Code's current-file/workspace filter untouched. Opening the view
                // makes successful builds with warnings just as easy to inspect as failures.
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            }
            vscode.window.showInformationMessage(`rm_debug：编译成功；${summary}。`);
        } catch (error) {
            this.failedBuildProjects.add(project);
            this.setState('编译失败');
            this.output.appendLine(`\n${String(error)}；错误 ${this.errorCount} 条，警告 ${this.warningCount} 条；耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
            this.output.show(true);
            vscode.commands.executeCommand('workbench.actions.view.problems');
            vscode.window.showErrorMessage(`rm_debug：${String(error)}`);
        } finally { this.busy = false; }
    }

    private firmware(folder: vscode.WorkspaceFolder, project: string, config: LaunchConfig | undefined): string {
        const configured = vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>('firmwarePath', '');
        const value = configured || config?.executable || '';
        const expanded = expandWorkspacePath(value, folder);
        return path.isAbsolute(expanded) ? expanded : path.resolve(project, expanded);
    }

    private async flash(): Promise<void> {
        if (this.busy) {
            vscode.window.showWarningMessage('rm_debug：已有命令正在运行。');
            return;
        }
        const folder = await this.workspaceFolder();
        if (!folder) { return; }
        if (this.mujoco.isEnabled(folder)) {
            void vscode.window.showInformationMessage('rm_debug：MuJoCo 仿真无需烧录。实物烧录请先配置嵌入式工程。');
            return;
        }
        if (this.desktop.isEnabled(folder)) {
            void vscode.window.showInformationMessage('rm_debug：桌面程序无需烧录，请点击 Debug 启动调试。');
            return;
        }
        const project = await this.projectDirectory(folder);
        if (!project) { return; }
        if (this.failedBuildProjects.has(project)) {
            vscode.window.showErrorMessage('rm_debug：上次编译失败，请先修复并重新编译，再烧录。');
            return;
        }
        if (vscode.debug.activeDebugSession?.type === 'cortex-debug') {
            vscode.window.showWarningMessage('rm_debug：请先结束当前调试会话，再烧录。');
            return;
        }
        const config = vscode.workspace.getConfiguration('rm-debug', folder.uri);
        const launch = this.workflowLaunch(folder);
        if (!launch) {
            vscode.window.showErrorMessage('rm_debug：找不到调试配置。请运行“Configure Workspace”。');
            return;
        }
        const firmware = this.firmware(folder, project, launch);
        if (!existingFile(firmware)) {
            vscode.window.showErrorMessage(`rm_debug：找不到固件 ${firmware}。请先编译或检查 ELF 路径。`);
            return;
        }
        const override = config.get<string>('flashCommand', '').trim();
        let command = override;
        let jlinkCommandFile = '';
        let jlinkCommandDirectory = '';
        if (!command) {
            const settings = vscode.workspace.getConfiguration('rm-debug');
            if (launch?.servertype === 'jlink') {
                const commander = settings.get<string>('jlinkCommanderPath', '');
                const device = launch.device || config.get<string>('jlinkDevice', '');
                if (!existingFile(commander) || !/^[A-Za-z0-9_.-]+$/.test(device)) {
                    vscode.window.showErrorMessage('rm_debug：缺少 J-Link Commander 或芯片型号。请运行“Configure Workspace”。');
                    return;
                }
                if (/[\r\n"]/.test(firmware)) {
                    vscode.window.showErrorMessage('rm_debug：ELF 路径含有不支持的字符。');
                    return;
                }
                jlinkCommandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-jlink-'));
                jlinkCommandFile = path.join(jlinkCommandDirectory, 'flash.jlink');
                const jlinkFirmware = firmware.replace(/\\/g, '/');
                fs.writeFileSync(jlinkCommandFile, [
                    'r', 'h', `loadfile "${jlinkFirmware}"`, 'r', 'g', 'q', ''
                ].join('\n'), 'utf8');
                command = [
                    bashQuote(bashPath(commander)), '-device', bashQuote(device), '-if', 'SWD',
                    '-speed', '4000', '-autoconnect', '1', '-NoGui', '1', '-ExitOnError', '1',
                    '-CommandFile', bashQuote(bashPath(jlinkCommandFile))
                ].join(' ');
            } else {
                const openocd = settings.get<string>('openocdPath', '') || launch?.serverpath || 'openocd';
                const scripts = settings.get<string>('openocdScriptsPath', '') || launch?.searchDir?.[0] || '';
                const files = launch?.configFiles?.length
                    ? launch.configFiles
                    : [config.get<string>('interfaceConfig', ''), config.get<string>('targetConfig', '')];
                if (files.some((file) => !file)) {
                    vscode.window.showErrorMessage('rm_debug：缺少 OpenOCD 接口或芯片配置。请运行“Configure Workspace”。');
                    return;
                }
                const args: string[] = [bashQuote(bashPath(openocd))];
                if (scripts) { args.push('-s', bashQuote(bashPath(scripts))); }
                for (const preConfigCommand of launch?.openOCDPreConfigLaunchCommands || []) {
                    args.push('-c', bashQuote(preConfigCommand));
                }
                for (const file of files) {
                    args.push('-f', bashQuote(file));
                }
                for (const launchCommand of launch?.openOCDLaunchCommands || []) {
                    args.push('-c', bashQuote(launchCommand));
                }
                args.push('-c', bashQuote(`program {${firmware.replace(/\\/g, '/')}} verify reset exit`));
                command = args.join(' ');
            }
        } else {
            command = command.replace(/\$\{firmware\}/g, bashQuote(bashPath(firmware)))
                .replace(/\$\{workspaceFolder\}/g, bashQuote(bashPath(folder.uri.fsPath)));
        }
        this.busy = true;
        this.output.clear();
        this.output.show(true);
        this.setState('烧录中');
        const started = Date.now();
        const flashLog = new FlashLog();
        let cancelled = false;
        const tool = override ? '自定义命令' : launch.servertype === 'jlink' ? 'J-Link' : 'OpenOCD';
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: 'rm_debug：烧录', cancellable: true
            }, async (_progress, token) => {
                try {
                    const exit = await this.runBash(command, project, token, false, (text) => flashLog.append(text));
                    if (token.isCancellationRequested) { throw new Error('烧录已取消'); }
                    if (exit !== 0) { throw new Error(`${tool} 烧录失败，退出码 ${exit}`); }
                } finally { cancelled = token.isCancellationRequested; }
            });
            this.failedFlashProjects.delete(project);
            this.setState('烧录成功');
            this.output.appendLine(`\n烧录成功，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
            vscode.window.showInformationMessage('rm_debug：烧录成功。');
        } catch (error) {
            this.failedFlashProjects.add(project);
            this.setState(cancelled ? '烧录已取消' : '烧录失败');
            this.output.appendLine(`\n${String(error)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
            this.output.show(true);
            if (cancelled) {
                vscode.window.showInformationMessage('rm_debug：烧录已取消，固件可能未完整写入，请重新烧录后再调试。');
            } else {
                const diagnoses = analyzeFlashFailure(`${flashLog.text}\n${String(error)}`);
                this.output.appendLine(formatFlashDiagnosis(diagnoses));
                void vscode.window.showErrorMessage(
                    `rm_debug：烧录失败。可能原因：${diagnoses[0].cause}。`, '查看分析与日志', '配置工程和工具路径'
                ).then((choice) => {
                    if (choice === '查看分析与日志') { this.output.show(false); }
                    if (choice === '配置工程和工具路径') { return vscode.commands.executeCommand('rm-debug.configure'); }
                });
            }
        } finally {
            this.busy = false;
            if (jlinkCommandFile && existingFile(jlinkCommandFile)) { fs.unlinkSync(jlinkCommandFile); }
            if (jlinkCommandDirectory && existingDirectory(jlinkCommandDirectory)) { fs.rmdirSync(jlinkCommandDirectory); }
        }
    }

    private async debug(): Promise<void> {
        if (this.busy) {
            vscode.window.showWarningMessage('rm_debug：请等待当前命令结束。');
            return;
        }
        const folder = await this.workspaceFolder();
        if (!folder) { return; }
        if (this.mujoco.isEnabled(folder)) {
            await this.mujoco.debug(folder);
            return;
        }
        if (this.desktop.isEnabled(folder)) {
            await this.desktop.debug(folder);
            return;
        }
        const project = await this.projectDirectory(folder);
        if (!project) { return; }
        if (this.failedFlashProjects.has(project)) {
            const choice = await vscode.window.showWarningMessage('rm_debug：上次烧录失败，仍要启动调试吗？', '继续调试');
            if (choice !== '继续调试') { return; }
        }
        const launch = this.workflowLaunch(folder);
        if (!launch?.name) {
            vscode.window.showErrorMessage('rm_debug：找不到调试配置。请运行“Configure Workspace”。');
            return;
        }
        const machine = vscode.workspace.getConfiguration('rm-debug');
        const bash = configuredBash(machine);
        const gdb = this.discoverGdb(bash, machine.get<string>('armGccPath', ''));
        if (!gdb) {
            vscode.window.showErrorMessage(`rm_debug：找不到 ${toolName('arm-none-eabi-gdb')}。请安装 ARM GDB（Ubuntu 也可用 gdb-multiarch）再运行“配置工程和工具路径”。`);
            return;
        }
        await this.saveGdbSettings(gdb);
        const success = await vscode.debug.startDebugging(folder, {
            ...launch,
            name: launch.name,
            type: 'cortex-debug',
            request: launch.request || 'launch',
            gdbPath: gdb,
            armToolchainPath: armToolchainDirectory(machine.get<string>('armGccPath', ''), gdb)
        });
        if (!success) { vscode.window.showErrorMessage('rm_debug：无法启动调试，请查看 Debug Console。'); }
    }
}
