import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import { inDirectory, nativeSearchOptions, normalizeLocations, scopeContains, scopeLabels, SearchKind, SearchScope } from './search-scope';

interface SearchSource {
    document: vscode.TextDocument;
    position: vscode.Position;
    query: string;
}

class SymbolResult extends vscode.TreeItem {
    constructor(readonly location: vscode.Location, snippet: string) {
        super(`${location.range.start.line + 1}:${location.range.start.character + 1}  ${snippet}`, vscode.TreeItemCollapsibleState.None);
        this.id = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`;
        this.tooltip = `${location.uri.fsPath}:${location.range.start.line + 1}\n${snippet}`;
        this.command = { command: 'rm-debug.search.openResult', title: '跳转到源码', arguments: [location] };
        this.iconPath = new vscode.ThemeIcon('symbol-variable');
    }
}

class ResultFile extends vscode.TreeItem {
    readonly children: SymbolResult[] = [];
    constructor(readonly uri: vscode.Uri) {
        super(vscode.workspace.asRelativePath(uri, true), vscode.TreeItemCollapsibleState.Expanded);
        this.resourceUri = uri;
        this.id = uri.toString();
        this.tooltip = uri.fsPath;
    }
}

export class SymbolResults implements vscode.TreeDataProvider<ResultFile | SymbolResult>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private files: ResultFile[] = [];
    getTreeItem(item: ResultFile | SymbolResult): vscode.TreeItem { return item; }
    getChildren(item?: ResultFile | SymbolResult): Array<ResultFile | SymbolResult> {
        return item instanceof ResultFile ? item.children : item ? [] : this.files;
    }

    getParent(item: ResultFile | SymbolResult): ResultFile | undefined {
        return item instanceof SymbolResult ? this.files.find((file) => file.children.includes(item)) : undefined;
    }

    clear(): void {
        this.files = [];
        this.changed.fire();
    }

    dispose(): void { this.changed.dispose(); }
    async load(locations: vscode.Location[]): Promise<ResultFile[]> {
        const groups = new Map<string, ResultFile>();
        for (const location of locations) {
            const key = location.uri.toString();
            if (!groups.has(key)) { groups.set(key, new ResultFile(location.uri)); }
        }
        // Open each document once and retain exact language-service ranges, including unsaved buffers.
        const files = await Promise.all([...groups.values()].map(async (file) => {
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(file.uri);
            } catch { /* Locations can outlive deleted files. */ }
            for (const location of locations.filter((value) => value.uri.toString() === file.uri.toString())) {
                const snippet = document && location.range.start.line < document.lineCount
                    ? document.lineAt(location.range.start.line).text.trim().slice(0, 240)
                    : '源码暂不可读取，点击尝试打开';
                file.children.push(new SymbolResult(location, snippet));
            }
            file.description = `${file.children.length} 处`;
            return file;
        }));
        return files;
    }

    publish(files: ResultFile[]): void {
        this.files = files;
        this.changed.fire();
    }
}

export class RmSearch implements vscode.Disposable {
    private lastEditor = vscode.window.activeTextEditor;
    private readonly results = new SymbolResults();
    private readonly view: vscode.TreeView<ResultFile | SymbolResult>;
    private readonly output = vscode.window.createOutputChannel('rm_debug 搜索与索引');
    private request = 0;
    private lastQuery = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        this.view = vscode.window.createTreeView('rm-debug.searchResults', { treeDataProvider: this.results });
        this.view.message = '将光标放在源码变量上，通过“变量搜索”选择定义或真实引用。';
        const register = (name: string, callback: (...args: any[]) => any) => vscode.commands.registerCommand(`rm-debug.search${name}`, callback);
        context.subscriptions.push(this, this.view, this.results, this.output,
            vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) { this.lastEditor = editor; } }),
            register('', () => this.search()),
            register('.currentFile', () => this.search('text', 'file')),
            register('.project', () => this.search('text', 'project')),
            register('.workspace', () => this.search('text', 'workspace')),
            register('.definition', () => this.search('definition')),
            register('.references', () => this.search('references')),
            register('.inspectIndex', () => this.inspectIndex()),
            register('.openResult', (location: vscode.Location) => vscode.window.showTextDocument(location.uri, {
                selection: location.range, preview: true
            })),
            register('.clearResults', () => {
                this.request++;
                this.results.clear();
                this.view.message = '结果已清空。';
            })
        );
    }

    dispose(): void { this.request++; }

    private source(): SearchSource | undefined {
        const editor = vscode.window.activeTextEditor || this.lastEditor;
        if (!editor || editor.document.isClosed) { return undefined; }
        const position = editor.selection.start;
        const word = editor.document.getWordRangeAtPosition(position);
        return { document: editor.document, position,
            query: editor.selection.isEmpty ? (word ? editor.document.getText(word) : '') : editor.document.getText(editor.selection).trim() };
    }

    private async folder(source: SearchSource): Promise<vscode.WorkspaceFolder | undefined> {
        const active = source && vscode.workspace.getWorkspaceFolder(source.document.uri);
        if (active) { return active; }
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 1) { return folders[0]; }
        if (!folders.length) {
            vscode.window.showWarningMessage('rm_debug：请先打开工程文件夹或工作区。');
            return undefined;
        }
        const choice = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), { title: '选择当前工程所在的工作区' });
        return choice?.folder;
    }

    private async project(folder: vscode.WorkspaceFolder, source: SearchSource): Promise<vscode.Uri> {
        const config = vscode.workspace.getConfiguration('rm-debug', folder.uri);
        const configured = config.get<string>('target') === 'mujoco'
            ? config.get<string>('mujoco.sourceDirectory', '')
            : config.get<string>('projectDirectory', '');
        if (configured) {
            if (path.isAbsolute(configured)) { return vscode.Uri.file(configured); }
            return vscode.Uri.joinPath(folder.uri, configured);
        }
        if (source && inDirectory(folder.uri, source.document.uri)) {
            let directory = vscode.Uri.joinPath(source.document.uri, '..');
            while (inDirectory(folder.uri, directory)) {
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, 'CMakeLists.txt'));
                    return directory;
                } catch { /* Try a containing project. Non-CMake folders fall back to the workspace root. */ }
                const parent = vscode.Uri.joinPath(directory, '..');
                if (parent.path === directory.path) { break; }
                directory = parent;
            }
        }
        return folder.uri;
    }

    async search(kind?: SearchKind, scope?: SearchScope): Promise<void> {
        const source = this.source(); // Capture before pickers or the Search view take focus.
        const generation = ++this.request;
        try {
            if (!kind) {
                const choice = await vscode.window.showQuickPick([
                    { label: '$(search) 文本检索', value: 'text' as SearchKind, description: '按变量名列出全部文本匹配，不依赖代码索引' },
                    { label: '$(go-to-file) 查找定义', value: 'definition' as SearchKind, description: '查找光标处变量的实际定义' },
                    { label: '$(references) 查找真实引用', value: 'references' as SearchKind, description: '查找同一个符号的引用，不混入其他同名变量' }
                ], { title: 'rm_debug 变量搜索：选择检索方式', ignoreFocusOut: true });
                if (!choice) { return; }
                kind = choice.value;
            }
            if (kind !== 'text' && (!source || !source.document.getWordRangeAtPosition(source.position))) {
                vscode.window.showWarningMessage('rm_debug：请先把光标放在源码变量或函数名上，再查找定义/真实引用。');
                return;
            }
            let folder: vscode.WorkspaceFolder;
            let project: vscode.Uri;
            if (!scope || scope === 'project') {
                folder = await this.folder(source);
                if (!folder) { return; }
                project = await this.project(folder, source);
            }
            if (!scope) {
                const choice = await vscode.window.showQuickPick([
                    { label: '$(files) 整个工作区', value: 'workspace' as SearchScope, description: '包含全部工作区根目录，不只搜索已打开的文件' },
                    { label: '$(file) 当前文件', value: 'file' as SearchScope, description: source?.document.uri.fsPath || '请先打开源码文件' },
                    { label: '$(folder) 当前工程', value: 'project' as SearchScope, description: project.fsPath }
                ], { title: `rm_debug：选择${kind === 'text' ? '文本检索' : kind === 'definition' ? '定义' : '引用'}范围`, ignoreFocusOut: true });
                if (!choice) { return; }
                scope = choice.value;
            }
            if (scope === 'file' && (!source || source.document.isUntitled)) {
                vscode.window.showWarningMessage('rm_debug：当前文件检索需要先打开已保存的源码文件。');
                return;
            }
            if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
                vscode.window.showWarningMessage('rm_debug：请先打开工程文件夹或工作区。');
                return;
            }
            if (kind === 'text') {
                const query = await vscode.window.showInputBox({
                    title: `rm_debug 文本检索 · ${scopeLabels[scope]}`, value: source?.query || this.lastQuery,
                    prompt: '输入变量名；结果在左侧原生搜索栏列出', ignoreFocusOut: true,
                    validateInput: (value) => !value.trim() ? '请输入变量名或搜索文本' : /[\r\n]/.test(value) ? '请输入单行文本' : undefined
                });
                if (query === undefined || generation !== this.request) { return; }
                this.lastQuery = query.trim();
                // Respect the requested sidebar destination even when this workspace previously selected a Search Editor.
                const settings = vscode.workspace.getConfiguration('search');
                if (settings.get<string>('mode', 'view') !== 'view') {
                    await settings.update('mode', 'view', vscode.ConfigurationTarget.Workspace);
                    this.output.appendLine('已将当前工作区 search.mode 设置为 view，使结果显示在左侧搜索栏。');
                }
                if (generation !== this.request) { return; }
                await vscode.commands.executeCommand('workbench.action.findInFiles', nativeSearchOptions(this.lastQuery, scope, source?.document.uri, project));
            } else {
                await this.symbolSearch(kind, scope, source, project, generation);
            }
        } catch (error) {
            if (generation === this.request) { vscode.window.showErrorMessage(`rm_debug：变量搜索失败：${String(error)}`); }
        }
    }

    private async symbolSearch(kind: SearchKind, scope: SearchScope, source: SearchSource, project: vscode.Uri, generation: number): Promise<void> {
        const label = kind === 'definition' ? '定义' : '真实引用';
        const locations = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: `rm_debug：查找 ${source.query} 的${label}`, cancellable: true
        }, async (_progress, token) => {
            let cancellation: vscode.Disposable;
            const cancelled = new Promise<undefined>((resolve) => {
                cancellation = token.onCancellationRequested(() => resolve(undefined));
            });
            try {
                if (token.isCancellationRequested) { return undefined; }
                const command = kind === 'definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';
                const response = await Promise.race([
                    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, source.document.uri, source.position), cancelled
                ]);
                return token.isCancellationRequested ? undefined : normalizeLocations(response || []);
            } finally { cancellation?.dispose(); }
        });
        if (generation !== this.request || locations === undefined) { return; }
        const filtered = locations.filter((location) => scopeContains(scope, location.uri, source.document.uri, project));
        const files = await this.results.load(filtered);
        if (generation !== this.request) { return; }
        this.results.publish(files);
        this.view.title = `符号结果 · ${label}`;
        this.view.description = `${source.query} · ${scopeLabels[scope]}`;
        this.view.message = `范围内 ${filtered.length} 处；语言服务返回 ${locations.length} 处。`
            + (locations.length !== filtered.length ? ' 部分结果位于所选范围外，可切换到整个工作区。' : '')
            + (!locations.length ? ' 未取得符号结果：请检查 C/C++ 或 clangd 索引；可使用文本检索查看同名位置。' : '');
        await vscode.commands.executeCommand('setContext', 'rm-debug.search.hasResults', true);
        await vscode.commands.executeCommand('rm-debug.searchResults.focus');
        if (files.length) { await this.view.reveal(files[0], { expand: true, focus: false, select: false }); }
        if (!locations.length) {
            void vscode.window.showWarningMessage('rm_debug：语言服务未返回符号结果，可能尚未完成工程索引。', '检查代码索引', '检索同名文本').then((choice) => {
                if (choice === '检查代码索引') { return this.inspectIndex(); }
                if (choice === '检索同名文本') { return this.search('text', scope); }
            });
        }
    }

    private async inspectIndex(): Promise<void> {
        const source = this.source();
        const folder = await this.folder(source);
        if (!folder) { return; }
        const project = await this.project(folder, source);
        this.output.clear();
        this.output.appendLine(`当前工作区：${folder.uri.fsPath}\n当前工程：${project.fsPath}\n当前文件：${source?.document.uri.fsPath || '无'}`);
        for (const id of ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd']) {
            const extension = vscode.extensions.getExtension(id);
            this.output.appendLine(`${id}：${extension ? extension.isActive ? '已激活' : '已安装，尚未激活' : '当前 Profile 未启用'}`);
        }
        const cpp = vscode.workspace.getConfiguration('C_Cpp', source?.document.uri || folder.uri);
        this.output.appendLine(`C/C++ 引擎：${cpp.get('intelliSenseEngine', 'default')}`);
        this.output.appendLine(`默认编译器：${cpp.get('default.compilerPath', '未配置')}`);
        try {
            const file = vscode.Uri.joinPath(folder.uri, '.vscode/c_cpp_properties.json');
            const content = parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
            this.output.appendLine(`\n配置文件：${file.fsPath}`);
            for (const config of content?.configurations || []) {
                this.output.appendLine(`配置 ${config.name}：compileCommands=${JSON.stringify(config.compileCommands || [])}`);
                for (const entry of Array.isArray(config.compileCommands) ? config.compileCommands : config.compileCommands ? [config.compileCommands] : []) {
                    const expanded = String(entry).replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, folder.uri.fsPath);
                    if (expanded.includes('${')) {
                        this.output.appendLine(`  ${expanded}：含待展开变量，请在 C/C++ 配置中核对。`);
                        continue;
                    }
                    const uri = path.isAbsolute(expanded) ? vscode.Uri.file(expanded) : vscode.Uri.joinPath(folder.uri, expanded);
                    try {
                        const database = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as Array<{ file: string }>;
                        this.output.appendLine(`  ${uri.fsPath}：存在，${database.length} 个编译单元。`);
                    } catch { this.output.appendLine(`  ${uri.fsPath}：无法读取，请先 Build 生成/修复编译数据库。`); }
                }
            }
        } catch { this.output.appendLine('未找到可读取的 c_cpp_properties.json；clangd 工程请核对 .clangd / compile_commands.json。'); }
        this.output.appendLine('\n检查工程根目录是否正确、源码是否参与编译，以及编译数据库是否包含该源码。');
        this.output.appendLine('C/C++ 可运行“重扫描工作区”；clangd 请核对编译数据库目录与后台索引，并等待索引完成。');
        this.output.show(false);
        if (vscode.extensions.getExtension('ms-vscode.cpptools')) {
            const choice = await vscode.window.showInformationMessage('rm_debug：索引检查已显示在输出栏。', '重扫描 C/C++ 工作区');
            if (choice) { await vscode.commands.executeCommand('C_Cpp.RescanWorkspace'); }
        }
    }
}
