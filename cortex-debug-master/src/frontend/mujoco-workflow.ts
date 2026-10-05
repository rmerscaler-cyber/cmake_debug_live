import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { nativeCompiler } from './desktop-config';
import {
    MUJOCO_LAUNCH, MUJOCO_HEADLESS, isMujocoLaunch, isHeadlessLaunch, mergeMujocoFile, mujocoConfiguration
} from './mujoco-config';

function fileExists(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch (_error) { return false; }
}

export class MujocoWorkflow {
    constructor(private readonly output: vscode.OutputChannel) { }

    isEnabled(folder: vscode.WorkspaceFolder): boolean {
        return vscode.workspace.getConfiguration('rm-debug', folder.uri).get('target') === 'mujoco';
    }

    private configurations(folder: vscode.WorkspaceFolder): Array<Record<string, any>> {
        return vscode.workspace.getConfiguration('launch', folder.uri).get<Array<Record<string, any>>>('configurations', []).filter(isMujocoLaunch);
    }

    private async selectLaunch(folder: vscode.WorkspaceFolder, headless: boolean): Promise<Record<string, any> | undefined> {
        const settings = vscode.workspace.getConfiguration('rm-debug', folder.uri);
        const name = settings.get<string>(headless ? 'mujoco.headlessLaunchName' : 'mujoco.launchName', '');
        const candidates = this.configurations(folder).filter((item) => isHeadlessLaunch(item) === headless);
        const saved = candidates.find((item) => item.name === name);
        if (saved) { return saved; }
        if (candidates.length === 1) { return candidates[0]; }
        if (candidates.length > 1) {
            return (await vscode.window.showQuickPick(candidates.map((config) => ({ label: config.name, config })),
                { title: 'rm_debug：选择 MuJoCo C++ 调试配置' }))?.config;
        }
        void vscode.window.showErrorMessage('rm_debug：未找到对应的 MuJoCo 配置，请先点击“配置 MuJoCo 仿真”。');
        return undefined;
    }

    private workspacePath(folder: vscode.WorkspaceFolder, file: string): string {
        const relative = path.relative(folder.uri.fsPath, file);
        if (!relative) { return '${workspaceFolder}'; }
        return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
            ? '${workspaceFolder}/' + relative.replace(/\\/g, '/')
            : file.replace(/\\/g, '/');
    }

    private async tool(folder: vscode.WorkspaceFolder, setting: string, names: string[], title: string): Promise<string | undefined> {
        const saved = vscode.workspace.getConfiguration('rm-debug', folder.uri).get<string>(setting, '');
        const compatibleSaved = setting === 'mujoco.pythonPath' || names.includes(path.basename(saved)) ? saved : '';
        const candidates = [compatibleSaved, ...(process.env.PATH || '').split(path.delimiter)
            .flatMap((directory) => names.map((name) => path.join(directory, name)))];
        const found = candidates.find((file) => file && fileExists(file) && nativeCompiler(file));
        if (found) { return found; }
        return await vscode.window.showInputBox({ title, validateInput: (value) =>
            fileExists(value) && nativeCompiler(value) ? undefined : '请选择已安装的本机工具完整路径。' });
    }

    async configure(folder: vscode.WorkspaceFolder): Promise<void> {
        if (process.platform !== 'linux') {
            void vscode.window.showErrorMessage('rm_debug：当前 MuJoCo C++ 仿真工作流支持 Linux + GDB。');
            return;
        }
        try {
            const existing = this.configurations(folder);
            const choice = await vscode.window.showQuickPick([
                ...(existing.length
                    ? [{ label: '接入已有 MuJoCo 调试配置', reuse: true,
                            description: '使用已有 launch.json 和编译任务' }]
                    : []),
                { label: '生成 MuJoCo C++ 调试配置', reuse: false, description: 'Python 仿真脚本 + CMake 本机 Debug 动态库' }
            ], { title: 'rm_debug：配置 MuJoCo 仿真' });
            if (!choice) { return; }
            const settings = vscode.workspace.getConfiguration('rm-debug', folder.uri);
            if (choice.reuse) {
                const windowLaunch = await this.selectLaunch(folder, false);
                if (!windowLaunch) { return; }
                const headless = existing.filter(isHeadlessLaunch);
                const headlessLaunch = headless.length === 1
                    ? headless[0]
                    : headless.length > 1
                        ? await this.selectLaunch(folder, true)
                        : undefined;
                if (headless.length > 1 && !headlessLaunch) { return; }
                await settings.update('mujoco.launchName', windowLaunch.name, vscode.ConfigurationTarget.WorkspaceFolder);
                await settings.update('mujoco.headlessLaunchName', headlessLaunch?.name || '', vscode.ConfigurationTarget.WorkspaceFolder);
            } else {
                const root = folder.uri.fsPath;
                const source = await vscode.window.showInputBox({ title: 'rm_debug：MuJoCo 本机 CMake 目录',
                    value: settings.get('mujoco.sourceDirectory', 'parallel_controller_mujoco/native'),
                    validateInput: (value) => fileExists(path.resolve(root, value, 'CMakeLists.txt')) ? undefined : '目录需要包含 CMakeLists.txt。' });
                if (!source?.trim()) { return; }
                const build = await vscode.window.showInputBox({ title: 'rm_debug：MuJoCo Debug 构建目录',
                    prompt: '需要与 Python 脚本加载动态库的目录一致。',
                    value: settings.get('mujoco.buildDirectory', path.join(path.dirname(source), 'build/native')),
                    validateInput: (value) => value.trim() ? undefined : '请输入构建目录。' });
                if (!build?.trim()) { return; }
                const script = await vscode.window.showInputBox({ title: 'rm_debug：MuJoCo Python 仿真入口',
                    prompt: '脚本需支持 --embedded、--headless 和 --duration。',
                    value: settings.get('mujoco.script', path.join(path.dirname(source), 'scripts/run_sim.py')),
                    validateInput: (value) => fileExists(path.resolve(root, value)) ? undefined : '找不到 Python 仿真脚本。' });
                if (!script?.trim()) { return; }
                const python = await this.tool(folder, 'mujoco.pythonPath', ['python3', 'python'], 'rm_debug：Python 路径');
                if (!python) { return; }
                const gdb = await this.tool(folder, 'desktop.debuggerPath', ['gdb'], 'rm_debug：本机 GDB 路径');
                if (!gdb) { return; }
                const cmake = await this.tool(folder, 'cmakePath', ['cmake'], 'rm_debug：CMake 路径');
                if (!cmake) { return; }
                const compiler = await this.tool(folder, 'desktop.compilerPath', ['g++', 'clang++'], 'rm_debug：本机 C++ 编译器');
                if (!compiler) { return; }
                const result = mujocoConfiguration({ python, gdb, cmake, compiler,
                    source: this.workspacePath(folder, path.resolve(root, source)),
                    build: this.workspacePath(folder, path.resolve(root, build)),
                    script: this.workspacePath(folder, path.resolve(root, script)), cwd: '${workspaceFolder}',
                    duration: settings.get<number>('mujoco.headlessDuration', 10) });
                const files: Array<[string, string]> = [];
                for (const [name, key, items, version] of [
                    ['launch.json', 'configurations', result.launches, '0.2.0'],
                    ['tasks.json', 'tasks', result.tasks, '2.0.0']
                ] as const) {
                    const file = path.join(root, '.vscode', name);
                    if (vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === file && doc.isDirty)) {
                        throw new Error(`请先保存 ${file}。`);
                    }
                    const text = fileExists(file) ? fs.readFileSync(file, 'utf8') : JSON.stringify({ version, [key]: [] }, null, 4);
                    files.push([file, mergeMujocoFile(text, key, items)]);
                }
                const edits = new vscode.WorkspaceEdit();
                for (const [file, text] of files) {
                    const uri = vscode.Uri.file(file);
                    if (fileExists(file)) {
                        const document = await vscode.workspace.openTextDocument(uri);
                        edits.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
                    } else {
                        edits.createFile(uri, { overwrite: false });
                        edits.insert(uri, new vscode.Position(0, 0), text);
                    }
                }
                if (!await vscode.workspace.applyEdit(edits)) { throw new Error('无法写入 MuJoCo 配置。'); }
                for (const [file] of files) {
                    if (!await (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).save()) { throw new Error(`无法保存 ${file}。`); }
                }
                for (const [key, value] of [
                    ['mujoco.sourceDirectory', source], ['mujoco.buildDirectory', build], ['mujoco.script', script],
                    ['mujoco.pythonPath', python], ['mujoco.launchName', MUJOCO_LAUNCH], ['mujoco.headlessLaunchName', MUJOCO_HEADLESS]
                ]) { await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder); }
            }
            await settings.update('target', 'mujoco', vscode.ConfigurationTarget.WorkspaceFolder);
            this.output.appendLine('MuJoCo C++ 仿真已接入：GDB 启动 Python，动态库加载后绑定 C/C++ 断点。');
            void vscode.window.showInformationMessage('rm_debug：MuJoCo 已配置。点击“MuJoCo 窗口调试”或“MuJoCo 无窗口调试”。');
        } catch (error) { void vscode.window.showErrorMessage(`rm_debug：${String(error)}`); }
    }

    async build(folder: vscode.WorkspaceFolder): Promise<void> {
        if (vscode.debug.activeDebugSession) {
            void vscode.window.showWarningMessage('rm_debug：请先结束当前调试会话，再编译 MuJoCo 动态库。');
            return;
        }
        const launch = await this.selectLaunch(folder, false);
        if (!launch || !await vscode.workspace.saveAll(false)) { return; }
        if (typeof launch.preLaunchTask !== 'string') {
            void vscode.window.showErrorMessage('rm_debug：MuJoCo 配置需要 preLaunchTask 编译本机 Debug 动态库。');
            return;
        }
        const task = (await vscode.tasks.fetchTasks()).find((item) => item.name === launch.preLaunchTask
            && typeof item.scope === 'object' && item.scope.uri.toString() === folder.uri.toString());
        if (!task) {
            void vscode.window.showErrorMessage(`rm_debug：找不到 MuJoCo 编译任务 ${launch.preLaunchTask}。`);
            return;
        }
        if (vscode.tasks.taskExecutions.some((item) => item.task.name === task.name && item.task.scope === task.scope)) {
            void vscode.window.showWarningMessage('rm_debug：MuJoCo 编译任务正在运行。');
            return;
        }
        await vscode.tasks.executeTask(task);
    }

    async debug(folder: vscode.WorkspaceFolder, headless = false): Promise<void> {
        if (!vscode.extensions.getExtension('ms-vscode.cpptools')) {
            void vscode.window.showErrorMessage('rm_debug：MuJoCo C++ 调试需要当前 Profile 安装并启用 Microsoft C/C++。');
            await vscode.commands.executeCommand('extension.open', 'ms-vscode.cpptools');
            return;
        }
        if (vscode.debug.activeDebugSession) {
            void vscode.window.showWarningMessage('rm_debug：请先结束当前调试会话，再启动 MuJoCo。');
            return;
        }
        const launch = await this.selectLaunch(folder, headless);
        if (!launch || !await vscode.workspace.saveAll(false)) { return; }
        this.output.appendLine(`MuJoCo：${launch.name}；启动前任务 ${launch.preLaunchTask || '无'}。`);
        if (!await vscode.debug.startDebugging(folder, launch.name)) {
            void vscode.window.showErrorMessage('rm_debug：MuJoCo 调试启动失败，请查看编译终端和 Debug Console。');
        }
    }
}
