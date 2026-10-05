import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import {
    DESKTOP_BUILD_TASK, DESKTOP_CONFIGURE_TASK, DESKTOP_LAUNCH_NAME,
    DesktopBuildMode, DesktopDebugger, DesktopOptions, desktopConfiguration, isCOrCppSource, isCppSource, nativeCompiler
} from './desktop-config';
import { prepareMixedCMake } from './cmake-project';

function existingFile(file: string): boolean {
    try {
        return !!file && fs.statSync(file).isFile();
    } catch (_error) {
        return false;
    }
}

export class DesktopWorkflow {
    constructor(private readonly output: vscode.OutputChannel) { }

    isEnabled(folder: vscode.WorkspaceFolder): boolean {
        return vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>('target', 'embedded') === 'desktop';
    }

    activeCompiler(): string {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.isUntitled || !isCOrCppSource(document.fileName)) {
            throw new Error('请先打开并保存 C/C++ 源文件。');
        }
        const settings = vscode.workspace.getConfiguration('rm-debug', document.uri);
        const compiler = settings.get<string>(isCppSource(document.fileName) ? 'desktop.compilerPath' : 'desktop.cCompilerPath', '');
        if (!existingFile(compiler)) { throw new Error('找不到本机编译器，请重新配置桌面 C/C++ 工程。'); }
        return compiler;
    }

    activeStandard(): string {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || !isCOrCppSource(document.fileName)) { throw new Error('请打开 C/C++ 源文件。'); }
        const settings = vscode.workspace.getConfiguration('rm-debug', document.uri);
        const cpp = isCppSource(document.fileName);
        const standard = settings.get<string>(cpp ? 'desktop.cppStandard' : 'desktop.cStandard', cpp ? 'c++20' : 'c11');
        return settings.get<string>('desktop.backend', 'gdb') === 'msvc'
            ? '/std:' + (cpp ? standard : standard === 'c17' ? 'c17' : 'c11')
            : '-std=' + standard;
    }

    private async tool(setting: string, names: string[], label: string, companion = ''): Promise<string | undefined> {
        const saved = vscode.workspace.getConfiguration('rm-debug').get<string>(setting, '');
        const directories = [...new Set([
            ...(companion ? [path.dirname(companion)] : []),
            ...(process.env.PATH || '').split(path.delimiter),
            ...(process.platform === 'win32'
                ? ['C:/msys64/ucrt64/bin', 'D:/msys64/ucrt64/bin',
                        'C:/msys64/mingw64/bin', 'D:/msys64/mingw64/bin', 'C:/mingw64/bin']
                : [])
        ])];
        const compatibleSaved = names.some((name) => path.basename(saved).toLowerCase() === name.toLowerCase()) ? saved : '';
        const found = [compatibleSaved, ...directories.flatMap((directory) => names.map((name) => path.join(directory, name)))]
            .find((file) => existingFile(file) && nativeCompiler(file));
        if (found) { return found; }
        const selected = await vscode.window.showOpenDialog({
            title: `rm_debug：选择本机 ${label}`, canSelectFiles: true, canSelectFolders: false, canSelectMany: false
        });
        const file = selected?.[0]?.fsPath;
        const compatible = file && names.some((name) => path.basename(file).toLowerCase() === name.toLowerCase());
        if (compatible && existingFile(file) && nativeCompiler(file)) { return file; }
        if (file) { void vscode.window.showErrorMessage(`rm_debug：请选择本机 ${names.join(' / ')}，不能混用 C、C++ 或 ARM 工具。`); }
        return undefined;
    }

    private readJson(file: string, initial: any): { text: string; value: any } {
        const document = vscode.workspace.textDocuments.find((item) => item.uri.fsPath === file);
        if (document?.isDirty) { throw new Error(`请先保存 ${file}，再配置桌面调试。`); }
        const text = existingFile(file) ? fs.readFileSync(file, 'utf8') : JSON.stringify(initial, null, 4) + '\n';
        const errors: ParseError[] = [];
        const value = parse(text, errors, { allowTrailingComma: true });
        if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`配置文件格式无效：${file}`);
        }
        return { text, value };
    }

    private mergedFile(file: string, key: string, items: Array<Record<string, any>>, names: string[], initial: any): string {
        const { text, value } = this.readJson(file, initial);
        if (value[key] !== undefined && !Array.isArray(value[key])) { throw new Error(`配置中的 ${key} 必须是数组：${file}`); }
        const identity = key === 'configurations' ? 'name' : 'label';
        const previous = (value[key] || []) as Array<Record<string, any>>;
        // Preserve user-edited arguments, source maps and environment on reconfiguration.
        const next = items.map((item) => {
            if (key !== 'configurations') { return item; }
            const old = previous.find((candidate) => candidate.name === item.name);
            if (!old) { return item; }
            const merged: Record<string, any> = { ...old, ...item, args: old.args || item.args, environment: old.environment || item.environment };
            if (Array.isArray(old.environment)) {
                const previousEnvironment = old.environment as Array<{ name: string; value: string }>;
                merged.environment = [...previousEnvironment.filter((entry) => entry.name !== 'PATH'), ...item.environment];
            }
            if (!item.preLaunchTask) { delete merged.preLaunchTask; }
            if (item.type === 'cppvsdbg') {
                delete merged.MIMode;
                delete merged.miDebuggerPath;
                delete merged.setupCommands;
                delete merged.externalConsole;
            } else { delete merged.console; }
            return merged;
        });
        return applyEdits(text, modify(text, [key],
            [...previous.filter((item) => !names.includes(item[identity])), ...next],
            { formattingOptions: { insertSpaces: true, tabSize: 4 } }));
    }

    private workspacePath(folder: vscode.WorkspaceFolder, file: string): string {
        const relative = path.relative(folder.uri.fsPath, file);
        return relative === ''
            ? '${workspaceFolder}'
            : (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
                    ? '${workspaceFolder}/' + relative.replace(/\\/g, '/')
                    : file.replace(/\\/g, '/');
    }

    async configure(folder: vscode.WorkspaceFolder): Promise<void> {
        try {
            const selected = await vscode.window.showQuickPick([
                { label: '当前 C/C++ 文件', mode: 'file' as DesktopBuildMode, description: '按文件类型选择 C 或 C++ 编译器' },
                { label: '桌面 CMake 工程', mode: 'cmake' as DesktopBuildMode, description: '构建 Debug 版本并调试指定程序' },
                { label: '已有桌面程序', mode: 'executable' as DesktopBuildMode, description: '调试已编译的 exe / 本机可执行文件' }
            ], { title: 'rm_debug：桌面 C/C++ 工程类型' });
            if (!selected) { return; }
            const backends: Array<{ label: string; backend: DesktopDebugger; description: string }> = [
                { label: 'GCC / MinGW + GDB', backend: 'gdb', description: 'Windows MinGW 或 Linux 原生 GCC' },
                ...(process.platform === 'win32'
                    ? [{ label: 'MSVC + Windows 调试器', backend: 'msvc' as DesktopDebugger,
                            description: '在 Visual Studio Developer PowerShell / Command Prompt 环境启动 VS Code' }]
                    : []),
                ...(process.platform === 'darwin'
                    ? [{ label: 'Clang + LLDB MI', backend: 'lldb' as DesktopDebugger, description: '需要支持 MI 的 lldb-mi' }]
                    : [])
            ];
            const backend = await vscode.window.showQuickPick(backends, { title: 'rm_debug：选择桌面编译器与调试器' });
            if (!backend) { return; }
            const machine = vscode.workspace.getConfiguration('rm-debug');
            const extension = process.platform === 'win32' ? '.exe' : '';
            const options: DesktopOptions = {
                platform: process.platform, debugger: backend.backend, mode: selected.mode,
                compiler: '', cCompiler: '', debuggerPath: '', cmake: '', ninja: '', project: '${workspaceFolder}', buildDirectory: '', program: ''
            };
            if (selected.mode !== 'executable') {
                const names = backend.backend === 'msvc'
                    ? ['cl.exe']
                    : backend.backend === 'lldb' ? ['clang++'] : [`g++${extension}`, `clang++${extension}`];
                const compiler = await this.tool('desktop.compilerPath', names, 'C++ 编译器');
                if (!compiler) { return; }
                options.compiler = compiler;
                const cCompiler = backend.backend === 'msvc'
                    ? compiler
                    : await this.tool('desktop.cCompilerPath', backend.backend === 'lldb' ? ['clang'] : [`gcc${extension}`, `clang${extension}`],
                        'C 编译器', compiler);
                if (!cCompiler) { return; }
                options.cCompiler = cCompiler;
            }
            if (backend.backend !== 'msvc') {
                const debuggerPath = await this.tool('desktop.debuggerPath',
                    backend.backend === 'gdb' ? [`gdb${extension}`] : ['lldb-mi'], '桌面调试器', options.compiler);
                if (!debuggerPath) { return; }
                options.debuggerPath = debuggerPath;
            }
            const settings = vscode.workspace.getConfiguration('rm-debug', folder.uri);
            let project = folder.uri.fsPath;
            if (selected.mode === 'cmake') {
                const directory = await vscode.window.showInputBox({
                    title: 'rm_debug：桌面 CMake 工程目录', value: settings.get('projectDirectory', '') || '.',
                    validateInput: (value) => existingFile(path.resolve(folder.uri.fsPath, value, 'CMakeLists.txt'))
                        ? undefined
                        : '目录内需要有 CMakeLists.txt。'
                });
                if (!directory) { return; }
                project = path.resolve(folder.uri.fsPath, directory);
                options.project = this.workspacePath(folder, project);
                options.buildDirectory = options.project + `/build/rm-desktop-${backend.backend}`;
                const cmake = await this.tool('cmakePath', [`cmake${extension}`], 'CMake', options.compiler);
                if (!cmake) { return; }
                options.cmake = cmake;
                if (backend.backend !== 'msvc') {
                    const ninja = await this.tool('ninjaPath', [`ninja${extension}`], 'Ninja', options.compiler);
                    if (!ninja) { return; }
                    options.ninja = ninja;
                }
                await prepareMixedCMake(project, true);
            }
            if (selected.mode !== 'file') {
                const program = await vscode.window.showInputBox({
                    title: 'rm_debug：桌面可执行程序路径',
                    prompt: '相对于工程目录，或填写绝对路径；CMake 工程可填写首次编译后才生成的程序。',
                    value: selected.mode === 'cmake'
                        ? `build/rm-desktop-${backend.backend}/${backend.backend === 'msvc' ? 'Debug/' : ''}app${extension}`
                        : '',
                    validateInput: (value) => !value.trim()
                        ? '请输入可执行程序路径。'
                        : selected.mode === 'executable' && !existingFile(path.resolve(project, value.trim()))
                            ? '找不到该程序。'
                            : undefined
                });
                if (!program) { return; }
                options.program = this.workspacePath(folder, path.resolve(project, program.trim()));
            }
            const result = desktopConfiguration(options);
            const launchFile = path.join(folder.uri.fsPath, '.vscode', 'launch.json');
            const tasksFile = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
            // Validate both files before editing either one.
            const launchText = this.mergedFile(launchFile, 'configurations', [result.launch], [DESKTOP_LAUNCH_NAME],
                { version: '0.2.0', configurations: [] });
            const tasksText = this.mergedFile(tasksFile, 'tasks', result.tasks, [DESKTOP_BUILD_TASK, DESKTOP_CONFIGURE_TASK],
                { version: '2.0.0', tasks: [] });
            const edits = new vscode.WorkspaceEdit();
            for (const [file, content] of [[launchFile, launchText], [tasksFile, tasksText]]) {
                const uri = vscode.Uri.file(file);
                if (existingFile(file)) {
                    const document = await vscode.workspace.openTextDocument(uri);
                    edits.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
                } else {
                    edits.createFile(uri, { overwrite: false });
                    edits.insert(uri, new vscode.Position(0, 0), content);
                }
            }
            if (!await vscode.workspace.applyEdit(edits)) { throw new Error('无法保存桌面调试配置。'); }
            for (const file of [launchFile, tasksFile]) {
                if (!await (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).save()) { throw new Error(`无法保存 ${file}`); }
            }
            for (const [key, value] of [
                ['desktop.compilerPath', options.compiler], ['desktop.cCompilerPath', options.cCompiler], ['desktop.debuggerPath', options.debuggerPath],
                ['cmakePath', options.cmake], ['ninjaPath', options.ninja]
            ]) {
                if (value) { await machine.update(key, value, vscode.ConfigurationTarget.Global); }
            }
            await settings.update('desktop.buildMode', selected.mode, vscode.ConfigurationTarget.WorkspaceFolder);
            await settings.update('desktop.backend', backend.backend, vscode.ConfigurationTarget.WorkspaceFolder);
            await settings.update('desktop.buildDirectory', `build/rm-desktop-${backend.backend}`, vscode.ConfigurationTarget.WorkspaceFolder);
            await settings.update('projectDirectory', path.relative(folder.uri.fsPath, project), vscode.ConfigurationTarget.WorkspaceFolder);
            await settings.update('target', 'desktop', vscode.ConfigurationTarget.WorkspaceFolder);
            this.output.appendLine(`桌面 C/C++：${backend.label}；类型 ${selected.mode}；配置 ${launchFile}`);
            void vscode.window.showInformationMessage('rm_debug：桌面 C/C++ 配置已保存。点击 Build 编译，点击 Debug 或按 F5 调试。');
            await this.ensureDebugger();
        } catch (error) { void vscode.window.showErrorMessage(`rm_debug：${String(error)}`); }
    }

    private async ensureDebugger(): Promise<boolean> {
        if (vscode.extensions.getExtension('ms-vscode.cpptools')) { return true; }
        void vscode.window.showErrorMessage('rm_debug：桌面调试需要 Microsoft C/C++ 扩展（ms-vscode.cpptools）。请在当前 Profile 安装并启用它。');
        await vscode.commands.executeCommand('extension.open', 'ms-vscode.cpptools');
        return false;
    }

    private async ready(folder: vscode.WorkspaceFolder): Promise<boolean> {
        const mode = vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>('desktop.buildMode', 'file');
        if (mode === 'file') {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || document.isUntitled || document.uri.scheme !== 'file' || !isCOrCppSource(document.fileName)
                || vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== folder.uri.toString()) {
                void vscode.window.showErrorMessage('rm_debug：请先打开并保存当前工作区的 C/C++ 源文件，再编译或调试。');
                return false;
            }
        }
        return vscode.workspace.saveAll(false);
    }

    async build(folder: vscode.WorkspaceFolder): Promise<void> {
        if (!await this.ready(folder)) { return; }
        if (vscode.workspace.getConfiguration('rm-debug', folder.uri).get('desktop.buildMode') === 'executable') {
            void vscode.window.showInformationMessage('rm_debug：当前模式直接调试已有程序；请使用程序原有的构建方式。');
            return;
        }
        if (vscode.debug.activeDebugSession) {
            void vscode.window.showWarningMessage('rm_debug：请先结束当前调试会话，再编译桌面程序。');
            return;
        }
        const task = (await vscode.tasks.fetchTasks()).find((candidate) => candidate.name === DESKTOP_BUILD_TASK
            && typeof candidate.scope === 'object' && candidate.scope.uri.toString() === folder.uri.toString());
        if (!task) {
            void vscode.window.showErrorMessage('rm_debug：找不到桌面编译任务，请重新运行 Configure Desktop C/C++。');
            return;
        }
        if (vscode.tasks.taskExecutions.some((execution) => execution.task.name === task.name && execution.task.scope === task.scope)) {
            void vscode.window.showWarningMessage('rm_debug：桌面编译任务正在运行。');
            return;
        }
        await vscode.tasks.executeTask(task);
    }

    async debug(folder: vscode.WorkspaceFolder): Promise<void> {
        if (!await this.ensureDebugger() || !await this.ready(folder)) { return; }
        const launch = vscode.workspace.getConfiguration('launch', folder.uri).get<any[]>('configurations', [])
            .find((item) => item.name === DESKTOP_LAUNCH_NAME);
        if (!launch || !['cppdbg', 'cppvsdbg'].includes(launch.type)) {
            void vscode.window.showErrorMessage('rm_debug：请先运行 Configure Desktop C/C++ 生成桌面调试配置。');
            return;
        }
        if (!await vscode.debug.startDebugging(folder, DESKTOP_LAUNCH_NAME)) {
            void vscode.window.showErrorMessage('rm_debug：桌面调试启动失败，请查看终端和 Debug Console。');
        }
    }
}
