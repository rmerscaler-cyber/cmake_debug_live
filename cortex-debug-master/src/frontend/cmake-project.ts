import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isCOrCppSource, isCppSource } from './desktop-config';

const SOURCES_BEGIN = '# rm_debug BEGIN managed sources';
const SOURCES_END = '# rm_debug END managed sources';
const INCLUDES_BEGIN = '# rm_debug BEGIN managed include directories';
const INCLUDES_END = '# rm_debug END managed include directories';
const SUBDIRS_BEGIN = '# rm_debug BEGIN managed subdirectories';
const SUBDIRS_END = '# rm_debug END managed subdirectories';
const SCOPE_WORDS = new Set(['PRIVATE', 'PUBLIC', 'INTERFACE']);
const INCLUDE_OPTIONS = new Set(['SYSTEM', 'BEFORE', 'AFTER']);
const CMAKE_SKIP_DIRS = new Set(['.git', '.vscode', 'build', 'cmake-build-debug', 'cmake-build-release', 'stm32cubemx']);

interface CMakeArgument {
    value: string;
    start: number;
    end: number;
    quoted: boolean;
}

interface CMakeCommand {
    name: string;
    start: number;
    end: number;
    openParen: number;
    closeParen: number;
    args: CMakeArgument[];
}

interface SourceReference {
    file: string;
    target: string;
    commandName: string;
    cmakeFile: string;
    commandStart: number;
    commandEnd: number;
    tokenStart: number;
    tokenEnd: number;
    managed: boolean;
}

interface IncludeReference {
    directory: string;
    target: string;
    cmakeFile: string;
    managed: boolean;
    visibility: string;
}

export interface CMakeGroup {
    id: string;
    label: string;
    directory: string;
    cmakeFile: string;
    parentId?: string;
    targets: string[];
    targetKinds: Record<string, 'executable' | 'library'>;
    hasDynamicSources: boolean;
    subdirectories: string[];
    sources: SourceReference[];
    includes: IncludeReference[];
}

type CMakeNodeKind = 'project' | 'group' | 'source' | 'include';

export class CMakeProjectTreeNode extends vscode.TreeItem {
    constructor(
        readonly kind: CMakeNodeKind,
        label: string,
        readonly groupId?: string,
        readonly source?: SourceReference,
        readonly include?: IncludeReference,
        readonly uncertain = false,
        collapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.contextValue = kind === 'source'
            ? (source ? 'rmDebugCmakeIncludedSource' : uncertain ? 'rmDebugCmakeUnknownSource' : 'rmDebugCmakeExcludedSource')
            : `rmDebugCmake${kind[0].toUpperCase()}${kind.slice(1)}`;
        if (kind === 'source' && source) {
            this.command = { command: 'vscode.open', title: '打开源文件', arguments: [vscode.Uri.file(source.file)] };
        }
    }
}

function skipLineComment(text: string, index: number): number {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end + 1;
}

function bracketDelimiter(text: string, index: number): string | undefined {
    if (text[index] !== '[') { return undefined; }
    const match = text.slice(index).match(/^\[(=*)\[/);
    return match ? `]${match[1]}]` : undefined;
}

function skipBracket(text: string, index: number, close: string): number {
    const end = text.indexOf(close, index);
    return end < 0 ? text.length : end + close.length;
}

function skipComment(text: string, index: number): number {
    const close = bracketDelimiter(text, index + 1);
    return close ? skipBracket(text, index + 1, close) : skipLineComment(text, index);
}

function findCloseParen(text: string, open: number): number {
    let depth = 1;
    let quote = false;
    for (let index = open + 1; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === '\\') {
                index++;
                continue;
            }
            if (char === '"') { quote = false; }
            continue;
        }
        if (char === '"') {
            quote = true;
            continue;
        }
        if (char === '#') {
            index = skipComment(text, index) - 1;
            continue;
        }
        const close = bracketDelimiter(text, index);
        if (close) {
            index = skipBracket(text, index, close) - 1;
            continue;
        }
        if (char === '(') { depth++; }
        if (char === ')' && --depth === 0) { return index; }
    }
    return -1;
}

function parseArguments(text: string, start: number, end: number): CMakeArgument[] {
    const args: CMakeArgument[] = [];
    let index = start;
    while (index < end) {
        while (index < end && /\s/.test(text[index])) {
            index++;
        }
        if (index >= end) { break; }
        if (text[index] === '#') {
            index = Math.min(end, skipComment(text, index));
            continue;
        }
        const tokenStart = index;
        let value = '';
        let quoted = false;
        const bracketClose = bracketDelimiter(text, index);
        if (bracketClose) {
            const openLength = bracketClose.length;
            const valueStart = index + openLength;
            const closeStart = text.indexOf(bracketClose, valueStart);
            const tokenEnd = closeStart < 0 || closeStart > end ? end : closeStart + bracketClose.length;
            value = text.slice(valueStart, closeStart < 0 || closeStart > end ? end : closeStart);
            args.push({ value, start: tokenStart, end: tokenEnd, quoted: true });
            index = tokenEnd;
            continue;
        }
        if (text[index] === '"') {
            quoted = true;
            index++;
            while (index < end) {
                if (text[index] === '\\' && index + 1 < end && ['\\', '"', 'n', 't', 'r'].includes(text[index + 1])) {
                    const escaped = text[index + 1];
                    value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
                    index += 2;
                } else if (text[index] === '"') {
                    index++;
                    break;
                } else {
                    value += text[index++];
                }
            }
        } else {
            while (index < end && !/\s/.test(text[index])) {
                if (text[index] === '#') { break; }
                value += text[index++];
            }
        }
        if (index === tokenStart) {
            index++;
            continue;
        }
        args.push({ value, start: tokenStart, end: index, quoted });
    }
    return args;
}

function parseCommands(text: string): CMakeCommand[] {
    const commands: CMakeCommand[] = [];
    let index = 0;
    while (index < text.length) {
        if (text[index] === '#') {
            index = skipComment(text, index);
            continue;
        }
        const bracketClose = bracketDelimiter(text, index);
        if (bracketClose) {
            index = skipBracket(text, index, bracketClose);
            continue;
        }
        if (!/[A-Za-z_]/.test(text[index])) {
            index++;
            continue;
        }
        const start = index;
        while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) {
            index++;
        }
        const name = text.slice(start, index).toLowerCase();
        while (index < text.length && /\s/.test(text[index])) {
            index++;
        }
        if (text[index] !== '(') { continue; }
        const openParen = index;
        const closeParen = findCloseParen(text, openParen);
        if (closeParen < 0) { break; }
        commands.push({
            name,
            start,
            end: closeParen + 1,
            openParen,
            closeParen,
            args: parseArguments(text, openParen + 1, closeParen)
        });
        index = closeParen + 1;
    }
    return commands;
}

export function mixedCMakeLanguages(text: string): string {
    const commands = parseCommands(text);
    const project = commands.find((command) => command.name === 'project');
    if (!project) { throw new Error('工程根目录的 CMakeLists.txt 中需要有 project() 声明。'); }
    const values = project.args.map((arg) => arg.value.toUpperCase());
    const languagesIndex = values.indexOf('LANGUAGES');
    // project(name) defaults to C and CXX. Explicit language lists need both enabled.
    const languageNames = new Set(['C', 'CXX', 'ASM', 'NONE', 'CUDA', 'OBJC', 'OBJCXX', 'FORTRAN', 'CSHARP', 'HIP', 'ISPC', 'SWIFT']);
    const shortSignature = values.length > 1 && values.slice(1).every((value) => languageNames.has(value));
    if (languagesIndex < 0 && !shortSignature) { return text; }
    const enabled = new Set(values.slice(languagesIndex < 0 ? 1 : languagesIndex + 1).filter((value) => languageNames.has(value)));
    for (const command of commands.filter((item) => item.name === 'enable_language')) {
        for (const arg of command.args) {
            enabled.add(arg.value.toUpperCase());
        }
    }
    const missing = ['C', 'CXX'].filter((language) => !enabled.has(language));
    if (!missing.length) { return text; }
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const block = `${newline}# rm_debug: enable C/C++ mixed compilation${newline}enable_language(${missing.join(' ')})${newline}`;
    return text.slice(0, project.end) + block + text.slice(project.end);
}

export function cmakeReferencesCpp(root: string): boolean {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && !CMAKE_SKIP_DIRS.has(entry.name) && entry.name !== 'node_modules'
                && cmakeReferencesCpp(path.join(root, entry.name))) { return true; }
        } else if (entry.isFile() && (entry.name === 'CMakeLists.txt' || entry.name.endsWith('.cmake'))) {
            const commands = parseCommands(fs.readFileSync(path.join(root, entry.name), 'utf8'));
            if (commands.some((command) => command.args.some((arg) => arg.value.split(';').some(isCppSource)))) { return true; }
        }
    }
    return false;
}

export function mixedCMakeCppStandard(text: string): string {
    const commands = parseCommands(text);
    const project = commands.find((command) => command.name === 'project');
    if (!project) { throw new Error('工程根目录的 CMakeLists.txt 中需要有 project() 声明。'); }
    const edits: Array<{ start: number; end: number; value: string }> = [];
    const missing: string[] = [];
    for (const [setting, value] of [['CMAKE_CXX_STANDARD', '20'], ['CMAKE_CXX_STANDARD_REQUIRED', 'ON']]) {
        const setters = commands.filter((command) => command.name === 'set' && command.args[0]?.value === setting);
        for (const setter of setters) {
            const argument = setter.args[1];
            if (argument?.value === value) { continue; }
            edits.push(argument
                ? { start: argument.start, end: argument.end, value }
                : { start: setter.closeParen, end: setter.closeParen, value: ` ${value}` });
        }
        // Set defaults before project()/targets, even when an old setter occurs later.
        if (!setters.some((setter) => setter.start < project.start
            && !setter.args.some((arg) => ['CACHE', 'PARENT_SCOPE'].includes(arg.value.toUpperCase())))) {
            missing.push(`set(${setting} ${value})`);
        }
    }
    if (missing.length) {
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        edits.push({ start: project.start, end: project.start,
            value: `# rm_debug: use C++20${newline}${missing.join(newline)}${newline}${newline}` });
    }
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    }
    return text;
}

export async function prepareMixedCMake(root: string, force = false): Promise<void> {
    if (!force && !cmakeReferencesCpp(root)) { return; }
    const file = path.join(root, 'CMakeLists.txt');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (document.isDirty && !await document.save()) { throw new Error(`无法保存 ${file}`); }
    const text = document.getText();
    const next = mixedCMakeCppStandard(mixedCMakeLanguages(text));
    if (next === text) { return; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), next);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) { throw new Error(`无法启用 C/C++ 混编：${file}`); }
}

function normalizeFile(file: string): string {
    const normalized = path.resolve(file).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function reservedWindowsName(name: string): boolean {
    const stem = path.basename(name).split('.')[0].toUpperCase();
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function resolveCMakePath(value: string, directory: string): string | undefined {
    let expanded = value;
    expanded = expanded.replace(/\$\{CMAKE_CURRENT_LIST_DIR\}|\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, directory);
    if (expanded.includes('$<') || expanded.includes('${') || expanded.includes('$')) { return undefined; }
    expanded = expanded.replace(/\\/g, path.sep);
    return path.resolve(directory, expanded);
}

function targetSourceFileArguments(args: CMakeArgument[]): CMakeArgument[] {
    const files: CMakeArgument[] = [];
    let fileSetMode = false;
    let inFileSetFiles = false;
    for (const arg of args) {
        const upper = arg.value.toUpperCase();
        if (SCOPE_WORDS.has(upper)) {
            fileSetMode = false;
            inFileSetFiles = false;
            continue;
        }
        if (upper === 'FILE_SET') {
            fileSetMode = true;
            inFileSetFiles = false;
            continue;
        }
        if (fileSetMode) {
            if (upper === 'FILES') {
                inFileSetFiles = true;
                continue;
            }
            if (!inFileSetFiles) { continue; }
        }
        files.push(arg);
    }
    return files;
}

function addManagedBlock(text: string, begin: string, end: string, body: string): string {
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = `${begin}${eol}${body.trimEnd().replace(/\r?\n/g, eol)}${eol}${end}`;
    if (start >= 0 && finish >= start) {
        const after = finish + end.length;
        return `${text.slice(0, start)}${block}${text.slice(after)}`;
    }
    if (!text) { return `${block}${eol}`; }
    const separator = /\r?\n$/.test(text) ? eol : eol + eol;
    return `${text}${separator}${block}${eol}`;
}

function removeManagedBlock(text: string, begin: string, end: string): string {
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (start < 0 || finish < start) { return text; }
    let from = start;
    let to = finish + end.length;
    if (from > 0 && text[from - 1] === '\n') {
        from--;
        if (from > 0 && text[from - 1] === '\r') { from--; }
    }
    if (text[to] === '\r') { to++; }
    if (text[to] === '\n') { to++; }
    return text.slice(0, from) + text.slice(to);
}

function managedBlock(text: string, begin: string, end: string): string | undefined {
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (start < 0 || finish < start) { return undefined; }
    return text.slice(start + begin.length, finish);
}

function renderIncludeCommands(
    directory: string,
    entries: Map<string, { target: string; directory: string; visibility: string }>
): string {
    const groups = new Map<string, { target: string; visibility: string; directories: string[] }>();
    for (const entry of entries.values()) {
        const key = `${entry.target}\n${entry.visibility}`;
        const group = groups.get(key) || { target: entry.target, visibility: entry.visibility, directories: [] };
        group.directories.push(entry.directory);
        groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) => `${left.target}\n${left.visibility}`.localeCompare(`${right.target}\n${right.visibility}`)).map((group) =>
        `target_include_directories(${group.target} ${group.visibility}\n`
        + `${group.directories.sort().map((item) => `    ${cmakePathExpression(directory, item)}`).join('\n')}\n)`
    ).join('\n');
}

function readManagedSources(text: string, directory: string): Map<string, Map<string, string>> {
    const result = new Map<string, Map<string, string>>();
    const block = managedBlock(text, SOURCES_BEGIN, SOURCES_END) || '';
    for (const command of parseCommands(block)) {
        if (command.name !== 'target_sources' || !command.args[0]) { continue; }
        const target = command.args[0].value;
        const files = result.get(target) || new Map<string, string>();
        for (const arg of targetSourceFileArguments(command.args.slice(1))) {
            const file = resolveCMakePath(arg.value, directory);
            if (file && isCOrCppSource(file)) { files.set(normalizeFile(file), file); }
        }
        result.set(target, files);
    }
    return result;
}

function renderSourceCommands(directory: string, groups: Map<string, Map<string, string>>): string {
    return [...groups.entries()].filter(([, files]) => files.size > 0).sort(([left], [right]) => left.localeCompare(right)).map(([target, files]) =>
        `target_sources(${target} PRIVATE\n`
        + `${[...files.values()].sort((left, right) => left.localeCompare(right))
            .map((file) => `    ${cmakePathExpression(directory, file)}`).join('\n')}\n)`
    ).join('\n');
}

function cmakePathExpression(cmakeDirectory: string, file: string): string {
    const relative = path.relative(cmakeDirectory, file).replace(/\\/g, '/');
    const suffix = relative && relative !== '.' ? `/${relative}` : '';
    if (/[\r\n;"$]/.test(suffix)) { throw new Error(`路径包含 CMake 不安全字符：${file}`); }
    return '"${CMAKE_CURRENT_LIST_DIR}' + suffix + '"';
}

function targetDefinitions(commands: CMakeCommand[]): Array<{ target: string; kind: 'executable' | 'library' }> {
    const result: Array<{ target: string; kind: 'executable' | 'library' }> = [];
    for (const command of commands) {
        if (['add_library', 'add_executable'].includes(command.name) && command.args[0]) {
            const target = command.args[0].value;
            const options = command.args.slice(1).map((arg) => arg.value.toUpperCase());
            if (!options.some((option) => ['ALIAS', 'IMPORTED', 'INTERFACE'].includes(option)) && !target.includes('$<')) {
                result.push({ target, kind: command.name === 'add_executable' ? 'executable' : 'library' });
            }
        }
    }
    const unique = new Map<string, { target: string; kind: 'executable' | 'library' }>();
    for (const item of result) {
        unique.set(item.target, item);
    }
    return [...unique.values()];
}

function parseGroupFile(group: CMakeGroup, text: string): void {
    const commands = parseCommands(text);
    const targetHint = text.match(/^\s*#\s*rm_debug target:\s*([^\r\n]+)/m)?.[1].trim();
    if (targetHint && (!group.targets.length || group.targets.includes(targetHint))) { group.targets = [targetHint]; }
    const localTargets = targetDefinitions(commands);
    if (localTargets.length) {
        group.targets = localTargets.map((item) => item.target);
        for (const item of localTargets) {
            group.targetKinds[item.target] = item.kind;
        }
    }
    for (const command of commands) {
        if (command.name === 'file' && command.args.some((arg) => /\*\.(c|cc|cpp|cxx)/i.test(arg.value))) {
            group.hasDynamicSources = true;
        }
        if (command.name === 'add_subdirectory' && command.args[0]) {
            const value = command.args[0].value;
            if (value && !value.includes('$')) {
                group.subdirectories.push(path.resolve(group.directory, value));
            }
        }
        if (command.name === 'target_sources' && command.args[0]) {
            const target = command.args[0].value;
            const remaining = command.args.slice(1);
            const sourceArgs = targetSourceFileArguments(remaining);
            for (const arg of sourceArgs) {
                const file = resolveCMakePath(arg.value, group.directory);
                if (!file) {
                    if (arg.value.includes('$')) { group.hasDynamicSources = true; }
                    continue;
                }
                if (!isCOrCppSource(file)) { continue; }
                const block = managedBlock(text, SOURCES_BEGIN, SOURCES_END);
                const blockStart = block ? text.indexOf(SOURCES_BEGIN) : -1;
                const managed = blockStart >= 0 && arg.start > blockStart && arg.start < text.indexOf(SOURCES_END, blockStart);
                group.sources.push({
                    file, target, commandName: command.name, cmakeFile: group.cmakeFile, commandStart: command.start,
                    commandEnd: command.end, tokenStart: arg.start, tokenEnd: arg.end, managed
                });
            }
        }
        if (['add_library', 'add_executable'].includes(command.name) && command.args[0]) {
            const target = command.args[0].value;
            const optionWords = new Set([
                'STATIC', 'SHARED', 'MODULE', 'OBJECT', 'EXCLUDE_FROM_ALL', 'WIN32', 'MACOSX_BUNDLE',
                'IMPORTED', 'GLOBAL', 'ALIAS', 'INTERFACE'
            ]);
            for (const arg of command.args.slice(1)) {
                if (optionWords.has(arg.value.toUpperCase())) { continue; }
                const file = resolveCMakePath(arg.value, group.directory);
                if (!file) {
                    if (arg.value.includes('$')) { group.hasDynamicSources = true; }
                    continue;
                }
                if (!isCOrCppSource(file)) { continue; }
                group.sources.push({
                    file, target, commandName: command.name, cmakeFile: group.cmakeFile, commandStart: command.start,
                    commandEnd: command.end, tokenStart: arg.start, tokenEnd: arg.end, managed: false
                });
            }
        }
        if (command.name === 'target_include_directories' && command.args[0]) {
            const target = command.args[0].value;
            let visibility = 'PRIVATE';
            const blockStart = text.indexOf(INCLUDES_BEGIN);
            const blockEnd = text.indexOf(INCLUDES_END, blockStart);
            for (const arg of command.args.slice(1)) {
                if (SCOPE_WORDS.has(arg.value.toUpperCase())) {
                    visibility = arg.value.toUpperCase();
                    continue;
                }
                if (INCLUDE_OPTIONS.has(arg.value.toUpperCase())) { continue; }
                const directory = resolveCMakePath(arg.value, group.directory);
                if (!directory) { continue; }
                group.includes.push({
                    directory, target, cmakeFile: group.cmakeFile,
                    managed: blockStart >= 0 && blockEnd > blockStart && arg.start > blockStart && arg.start < blockEnd,
                    visibility
                });
            }
        }
    }
    group.subdirectories = [...new Set(group.subdirectories)];
}

function itemLabel(file: string, root: string): string {
    return path.relative(root, file).replace(/\\/g, '/');
}

export class CMakeProjectProvider implements vscode.TreeDataProvider<CMakeProjectTreeNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<CMakeProjectTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly groups = new Map<string, CMakeGroup>();
    private readonly documents = new Map<string, string>();
    private readonly compiledSources = new Set<string>();
    private compileCommandsFresh = false;
    private projectRoot?: string;
    private rootNode?: CMakeProjectTreeNode;
    private readonly cmakeWatcher: vscode.FileSystemWatcher;
    private readonly sourceWatcher: vscode.FileSystemWatcher;
    private readonly workspaceFoldersChanged: vscode.Disposable;
    private refreshTimer?: NodeJS.Timeout;

    constructor(
        private readonly getProjectRoot: () => Promise<string | undefined>,
        private readonly getCompileCommandsFile: (projectRoot: string) => string
    ) {
        this.cmakeWatcher = vscode.workspace.createFileSystemWatcher('**/CMakeLists.txt');
        this.sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{c,C,cc,CC,cpp,CPP,cxx,CXX,c++}');
        this.cmakeWatcher.onDidChange(() => this.scheduleRefresh());
        this.cmakeWatcher.onDidCreate(() => this.scheduleRefresh());
        this.cmakeWatcher.onDidDelete(() => this.scheduleRefresh());
        this.sourceWatcher.onDidCreate(() => this.scheduleRefresh());
        this.sourceWatcher.onDidDelete(() => this.scheduleRefresh());
        this.workspaceFoldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.projectRoot = undefined;
            this.refresh();
        });
    }

    dispose(): void {
        this.cmakeWatcher.dispose();
        this.sourceWatcher.dispose();
        this.workspaceFoldersChanged.dispose();
        this.changed.dispose();
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => this.refresh(), 200);
    }

    refresh(reselectProject = false): void {
        this.groups.clear();
        this.documents.clear();
        this.compiledSources.clear();
        this.compileCommandsFresh = false;
        this.rootNode = undefined;
        if (reselectProject) { this.projectRoot = undefined; }
        this.changed.fire(undefined);
    }

    getTreeItem(item: CMakeProjectTreeNode): vscode.TreeItem { return item; }

    async getChildren(element?: CMakeProjectTreeNode): Promise<CMakeProjectTreeNode[]> {
        if (!element) {
            const root = await this.load();
            return root ? [root] : [];
        }
        if (element.kind === 'project') {
            const root = await this.load();
            const group = root?.groupId ? this.groups.get(root.groupId) : undefined;
            return group ? this.groupChildren(group) : [];
        }
        if (element.kind === 'group' && element.groupId) {
            const group = this.groups.get(element.groupId);
            return group ? this.groupChildren(group) : [];
        }
        return [];
    }

    async load(): Promise<CMakeProjectTreeNode | undefined> {
        if (this.rootNode && this.projectRoot) { return this.rootNode; }
        const root = this.projectRoot && fs.existsSync(path.join(this.projectRoot, 'CMakeLists.txt'))
            ? this.projectRoot
            : await this.getProjectRoot();
        if (!root || !fs.existsSync(path.join(root, 'CMakeLists.txt'))) { return undefined; }
        this.groups.clear();
        this.documents.clear();
        this.projectRoot = root;
        const top = await this.readGroup(root, undefined, undefined, undefined, new Set<string>());
        if (!top) { return undefined; }
        this.loadCompileCommands(root);
        this.rootNode = new CMakeProjectTreeNode(
            'project', path.basename(root), top.id, undefined, undefined, false, vscode.TreeItemCollapsibleState.Expanded
        );
        this.rootNode.description = 'CMake 工程';
        this.rootNode.iconPath = new vscode.ThemeIcon('project');
        this.rootNode.resourceUri = vscode.Uri.file(root);
        return this.rootNode;
    }

    getGroups(): CMakeGroup[] { return [...this.groups.values()]; }
    isCompileCommandsFresh(): boolean { return this.compileCommandsFresh; }
    isCompiled(file: string): boolean { return this.compiledSources.has(normalizeFile(file)); }

    private loadCompileCommands(root: string): void {
        const database = this.getCompileCommandsFile(root);
        if (!fs.existsSync(database)) { return; }
        try {
            const stat = fs.statSync(database);
            const newestCMake = Math.max(0, ...[...this.groups.values()].map((group) => {
                try {
                    return fs.statSync(group.cmakeFile).mtimeMs;
                } catch (_error) {
                    return 0;
                }
            }));
            if (stat.mtimeMs <= newestCMake) { return; }
            const entries = JSON.parse(fs.readFileSync(database, 'utf8')) as Array<{ file?: string; directory?: string }>;
            for (const entry of entries) {
                if (!entry.file) { continue; }
                const file = path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory || root, entry.file);
                this.compiledSources.add(normalizeFile(file));
            }
            this.compileCommandsFresh = true;
        } catch (_error) {
            this.compiledSources.clear();
            this.compileCommandsFresh = false;
        }
    }

    private async readGroup(
        directory: string,
        parentId: string | undefined,
        inheritedTargets: string[] | undefined,
        inheritedTargetKinds: Record<string, 'executable' | 'library'> | undefined,
        visited: Set<string>
    ): Promise<CMakeGroup | undefined> {
        const cmakeFile = path.join(directory, 'CMakeLists.txt');
        if (!this.projectRoot || !inside(this.projectRoot, directory) || !fs.existsSync(cmakeFile)) { return undefined; }
        const key = normalizeFile(cmakeFile);
        if (visited.has(key)) { return this.groups.get(key); }
        visited.add(key);
        const group: CMakeGroup = {
            id: key, label: path.basename(directory) || path.basename(this.projectRoot), directory,
            cmakeFile, parentId, targets: inheritedTargets ? [...inheritedTargets] : [],
            targetKinds: inheritedTargetKinds ? { ...inheritedTargetKinds } : {},
            hasDynamicSources: false,
            subdirectories: [], sources: [], includes: []
        };
        this.groups.set(key, group);
        const text = await this.readText(cmakeFile);
        parseGroupFile(group, text);
        for (const subdirectory of group.subdirectories) {
            if (!inside(this.projectRoot, subdirectory)) { continue; }
            const name = path.basename(subdirectory).toLowerCase();
            if (CMAKE_SKIP_DIRS.has(name) || name.startsWith('.')) { continue; }
            await this.readGroup(subdirectory, group.id, group.targets, group.targetKinds, visited);
        }
        return group;
    }

    private async readText(file: string): Promise<string> {
        const key = normalizeFile(file);
        if (this.documents.has(key)) { return this.documents.get(key); }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const text = document.getText();
        this.documents.set(key, text);
        return text;
    }

    private async groupChildren(group: CMakeGroup): Promise<CMakeProjectTreeNode[]> {
        if (!this.projectRoot) { return []; }
        const nodes: CMakeProjectTreeNode[] = [];
        for (const subdirectory of group.subdirectories) {
            const child = this.groups.get(normalizeFile(path.join(subdirectory, 'CMakeLists.txt')));
            if (!child) { continue; }
            const node = new CMakeProjectTreeNode(
                'group', child.label, child.id, undefined, undefined, false, vscode.TreeItemCollapsibleState.Collapsed
            );
            node.description = child.targets.join(', ') || '分组';
            node.resourceUri = vscode.Uri.file(child.directory);
            node.iconPath = new vscode.ThemeIcon('folder-library');
            node.tooltip = `${child.directory}\n${child.cmakeFile}`;
            nodes.push(node);
        }

        const includedFiles = new Set<string>();
        for (const source of group.sources) {
            includedFiles.add(normalizeFile(source.file));
        }
        let candidates: string[] = [];
        try {
            candidates = (await fs.promises.readdir(group.directory, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && isCOrCppSource(entry.name))
                .map((entry) => path.join(group.directory, entry.name));
        } catch (_error) { /* The folder may have been removed while the tree was open. */ }

        const displayed = new Set<string>();
        for (const source of group.sources) {
            const key = `${normalizeFile(source.file)}\n${source.target}`;
            if (displayed.has(key)) { continue; }
            displayed.add(key);
            const state = source.managed ? '插件管理' : 'CMake';
            const node = new CMakeProjectTreeNode('source', path.basename(source.file), group.id, source);
            node.resourceUri = vscode.Uri.file(source.file);
            const buildState = this.compileCommandsFresh
                ? (this.isCompiled(source.file) ? '当前构建已编译' : '当前构建未编译')
                : 'CMake 已声明，Build 后核对';
            node.description = `${source.target} · ${state} · ${buildState}`;
            node.tooltip = `${source.file}\nCMake 声明目标：${source.target}\n声明：${source.cmakeFile}\n${buildState}`;
            node.iconPath = new vscode.ThemeIcon('file-code');
            nodes.push(node);
        }
        for (const file of candidates) {
            const key = normalizeFile(file);
            if (includedFiles.has(key)) { continue; }
            const inCompileDatabase = this.compileCommandsFresh && this.isCompiled(file);
            const uncertain = inCompileDatabase || (group.hasDynamicSources && !this.compileCommandsFresh);
            const node = new CMakeProjectTreeNode('source', path.basename(file), group.id, undefined, undefined, uncertain);
            node.resourceUri = vscode.Uri.file(file);
            node.command = { command: 'vscode.open', title: '打开源文件', arguments: [node.resourceUri] };
            node.description = inCompileDatabase
                ? '编译数据库包含，CMake 声明未识别'
                : uncertain
                    ? '状态待确认（动态 CMake 源清单）'
                    : this.compileCommandsFresh ? '未加入当前构建' : '未找到明确的 CMake 源项';
            node.tooltip = inCompileDatabase
                ? `${file}\n当前 compile_commands.json 包含此文件，但分组 CMake 中没有可识别的显式声明。不要直接重复添加，请检查动态源清单。`
                : uncertain
                    ? `${file}\n该分组包含 GLOB 或变量源清单，且编译数据库尚未确认。请先检查 ${group.cmakeFile}。`
                    : `${file}\n此文件尚未在当前分组 CMakeLists.txt 中找到明确的编译声明。`;
            node.iconPath = new vscode.ThemeIcon(uncertain ? 'question' : 'circle-outline');
            nodes.push(node);
        }
        for (const include of group.includes) {
            const node = new CMakeProjectTreeNode('include', itemLabel(include.directory, this.projectRoot), group.id, undefined, include);
            node.description = `${include.target} · ${include.managed ? '插件管理' : 'CMake'}`;
            node.tooltip = include.directory;
            node.iconPath = new vscode.ThemeIcon('symbol-namespace');
            nodes.push(node);
        }
        return nodes;
    }
}

export class CMakeProjectManager implements vscode.Disposable {
    readonly provider: CMakeProjectProvider;
    private readonly output = vscode.window.createOutputChannel('rm_debug CMake');
    private readonly treeView: vscode.TreeView<CMakeProjectTreeNode>;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        context: vscode.ExtensionContext,
        getProjectRoot: () => Promise<string | undefined>,
        getCompileCommandsFile: (projectRoot: string) => string
    ) {
        this.provider = new CMakeProjectProvider(getProjectRoot, getCompileCommandsFile);
        this.treeView = vscode.window.createTreeView('rm-debug.cmakeProject', {
            treeDataProvider: this.provider,
            showCollapseAll: true
        });
        this.disposables.push(this.provider, this.treeView, this.output);
        this.register(context, 'rm-debug.cmake.refresh', () => this.provider.refresh(true));
        this.register(context, 'rm-debug.cmake.addSource', (node?: CMakeProjectTreeNode) => this.addSources(node));
        this.register(context, 'rm-debug.cmake.createSource', (node?: CMakeProjectTreeNode) => this.createSource(node));
        this.register(context, 'rm-debug.cmake.removeSource', (node?: CMakeProjectTreeNode) => this.removeSources(node));
        this.register(context, 'rm-debug.cmake.addInclude', (node?: CMakeProjectTreeNode) => this.addInclude(node));
        this.register(context, 'rm-debug.cmake.removeInclude', (node?: CMakeProjectTreeNode) => this.removeInclude(node));
        this.register(context, 'rm-debug.cmake.createGroup', (node?: CMakeProjectTreeNode) => this.createGroup(node));
        this.register(context, 'rm-debug.cmake.openGroupCMake', (node?: CMakeProjectTreeNode) => this.openGroupCMake(node));
        this.register(context, 'rm-debug.cmake.openDeclaration', (node?: CMakeProjectTreeNode) => this.openDeclaration(node));
        context.subscriptions.push(this);
    }

    dispose(): void { vscode.Disposable.from(...this.disposables).dispose(); }

    private register(context: vscode.ExtensionContext, id: string, callback: (...args: any[]) => any): void {
        const disposable = vscode.commands.registerCommand(id, async (...args: any[]) => {
            try {
                await callback(...args);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(`[error] ${id}: ${message}`);
                vscode.window.showErrorMessage(`rm_debug CMake：${message}`);
            }
        });
        this.disposables.push(disposable);
        context.subscriptions.push(disposable);
    }

    private async groupFor(node?: CMakeProjectTreeNode): Promise<CMakeGroup | undefined> {
        await this.provider.load();
        const groups = this.provider.getGroups();
        const selectedId = node?.kind === 'project' || node?.kind === 'group' || node?.kind === 'source' || node?.kind === 'include'
            ? node.groupId
            : undefined;
        if (selectedId) { return groups.find((group) => group.id === selectedId); }
        const projectRoot = groups.find((group) => !group.parentId)?.directory || '';
        const selected = await vscode.window.showQuickPick(groups.map((group) => ({
            label: group.label,
            description: `${path.relative(projectRoot, group.directory) || '.'} · ${group.targets.join(', ') || '未识别目标'}`,
            group
        })), { placeHolder: '选择 CMake 编译分组' });
        return selected?.group;
    }

    private async chooseTarget(group: CMakeGroup): Promise<string | undefined> {
        if (group.targets.length === 1) { return group.targets[0]; }
        if (!group.targets.length) {
            vscode.window.showErrorMessage(`rm_debug：未能从 ${group.cmakeFile} 或其父分组识别 CMake target。`);
            return undefined;
        }
        return await vscode.window.showQuickPick(group.targets, { placeHolder: '选择要添加文件的 CMake target' });
    }

    private async projectRoot(): Promise<string | undefined> {
        const root = await this.provider.load();
        const group = root?.groupId ? this.provider.getGroups().find((item) => item.id === root.groupId) : undefined;
        return group?.directory;
    }

    private async openGroupCMake(node?: CMakeProjectTreeNode): Promise<void> {
        await this.provider.load();
        const group = node?.groupId ? this.provider.getGroups().find((item) => item.id === node.groupId) : undefined;
        if (group) { await vscode.window.showTextDocument(vscode.Uri.file(group.cmakeFile)); }
    }

    private async openDeclaration(node?: CMakeProjectTreeNode): Promise<void> {
        if (!node?.source) { return; }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.source.cmakeFile));
        const editor = await vscode.window.showTextDocument(document);
        const position = document.positionAt(node.source.commandStart);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private async addSources(node?: CMakeProjectTreeNode): Promise<void> {
        const group = await this.groupFor(node);
        if (!group) { return; }
        const target = await this.chooseTarget(group);
        if (!target) { return; }
        const selected = node?.kind === 'source' && !node.source && !node.uncertain && node.resourceUri
            ? [node.resourceUri]
            : await vscode.window.showOpenDialog({
                title: '选择要加入该 CMake 分组编译的 C/C++ 文件',
                defaultUri: vscode.Uri.file(group.directory),
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                filters: { 'C/C++ 源文件': ['c', 'C', 'cpp', 'cc', 'cxx', 'c++'] }
            });
        if (!selected?.length) { return; }
        const root = await this.projectRoot();
        if (!root) { return; }
        const files = [...new Set(selected.map((item) => path.resolve(item.fsPath)))];
        const realRoot = fs.realpathSync(root);
        for (const file of files) {
            let realFile = file;
            try {
                realFile = fs.realpathSync(file);
            } catch (_error) {
                /* Report the same validation error below. */
            }
            if (!inside(realRoot, realFile) || !isCOrCppSource(file) || !fs.existsSync(file)) {
                vscode.window.showErrorMessage(`rm_debug：只允许加入当前工程内已存在的 C/C++ 文件：${file}`);
                return;
            }
            if (/[\r\n;"$]/.test(path.relative(group.directory, file))) {
                vscode.window.showErrorMessage(`rm_debug：文件路径包含 CMake 不安全字符：${file}`);
                return;
            }
        }
        const unresolvedBuildSources = files.filter((file) => this.provider.isCompileCommandsFresh()
            && this.provider.isCompiled(file)
            && !this.provider.getGroups().some((candidateGroup) =>
                candidateGroup.sources.some((source) => normalizeFile(source.file) === normalizeFile(file))
            ));
        if (unresolvedBuildSources.length) {
            vscode.window.showErrorMessage(
                `这些文件已出现在当前 compile_commands.json，但插件无法找到它们的静态 CMake 声明，已停止添加以免重复编译：`
                + `${unresolvedBuildSources.map((file) => path.basename(file)).join(', ')}。请先检查现有 GLOB/变量源清单。`
            );
            return;
        }
        if (group.hasDynamicSources) {
            const choice = await vscode.window.showWarningMessage(
                `当前分组含有 GLOB 或变量源清单，无法确认所选文件是否已经自动编译。`,
                '仍加入明确文件'
            );
            if (choice !== '仍加入明确文件') { return; }
        }
        const otherTargets = [...new Set(this.provider.getGroups().flatMap((candidateGroup) => candidateGroup.sources)
            .filter((source) => files.some((file) => normalizeFile(file) === normalizeFile(source.file)) && source.target !== target)
            .map((source) => source.target))];
        if (otherTargets.length) {
            const choice = await vscode.window.showWarningMessage(
                `部分文件已经加入其他 target（${otherTargets.join(', ')}）。加入 ${target} 可能造成重复编译或链接冲突。`,
                '仍然加入'
            );
            if (choice !== '仍然加入') { return; }
        }
        await this.mutateSources(group, target, files, true);
    }

    private async createSource(node?: CMakeProjectTreeNode): Promise<void> {
        const group = await this.groupFor(node);
        if (!group) { return; }
        if (group.hasDynamicSources) {
            vscode.window.showWarningMessage(
                '该分组使用 GLOB 或变量生成源文件清单。新建文件可能自动进入编译，请先检查分组 CMakeLists.txt。'
            );
            return;
        }
        const target = await this.chooseTarget(group);
        if (!target) { return; }
        const name = await vscode.window.showInputBox({
            prompt: '新建 C/C++ 文件并加入当前分组编译',
            placeHolder: '例如 pid.c 或 controller.cpp',
            validateInput: (value) => {
                const normalized = value.trim();
                if (!/^[A-Za-z0-9_.+-]+$/.test(normalized) || !isCOrCppSource(normalized) || reservedWindowsName(normalized)) {
                    return '请输入有效的 C/C++ 文件名，不要包含目录路径或 Windows 保留名称。';
                }
                if (fs.existsSync(path.join(group.directory, normalized))) { return '文件已存在，不会覆盖。'; }
                return undefined;
            }
        });
        if (!name) { return; }
        const file = path.join(group.directory, name.trim());
        const confirmed = await vscode.window.showInformationMessage(
            `将在分组中创建 ${path.basename(file)} 并加入 ${target} 编译。`, '创建并加入'
        );
        if (confirmed !== '创建并加入') { return; }
        await this.createFileAndAdd(group, target, file);
    }

    private async mutateSources(group: CMakeGroup, target: string, files: string[], adding: boolean, confirmed = false): Promise<void> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(group.cmakeFile));
        const oldText = document.getText();
        const managedSources = readManagedSources(oldText, group.directory);
        const sourceSet = managedSources.get(target) || new Map<string, string>();
        const before = new Set(sourceSet.keys());
        const existingInProject = new Map<string, SourceReference>();
        for (const candidateGroup of this.provider.getGroups()) {
            for (const source of candidateGroup.sources) {
                if (source.target === target) { existingInProject.set(normalizeFile(source.file), source); }
            }
        }
        for (const file of files) {
            const key = normalizeFile(file);
            if (adding) {
                if (existingInProject.has(key) || sourceSet.has(key)) { continue; }
                sourceSet.set(key, file);
            } else {
                sourceSet.delete(key);
            }
        }
        if (sourceSet.size) {
            managedSources.set(target, sourceSet);
        } else {
            managedSources.delete(target);
        }
        let nextText = removeManagedBlock(oldText, SOURCES_BEGIN, SOURCES_END);
        const sourceBody = renderSourceCommands(group.directory, managedSources);
        if (sourceBody) {
            const body = sourceBody;
            nextText = addManagedBlock(nextText, SOURCES_BEGIN, SOURCES_END, body);
        }
        if (nextText === oldText) {
            if (adding) { vscode.window.showInformationMessage('所选文件已经加入该 CMake target。'); }
            return;
        }
        const count = adding
            ? files.filter((file) => !before.has(normalizeFile(file)) && sourceSet.has(normalizeFile(file))).length
            : files.filter((file) => before.has(normalizeFile(file))).length;
        if (!count) {
            vscode.window.showInformationMessage(
                adding ? '所选文件已经加入该 CMake target。' : '所选文件不在插件管理的 CMake 编译清单中。'
            );
            return;
        }
        const action = adding ? '加入' : '移出';
        if (!confirmed) {
            const changedFiles = files.filter((file) => adding
                ? !before.has(normalizeFile(file)) && sourceSet.has(normalizeFile(file))
                : before.has(normalizeFile(file)));
            const names = changedFiles.slice(0, 8).map((file) => itemLabel(file, group.directory)).join('、');
            const suffix = changedFiles.length > 8 ? ` 等 ${changedFiles.length} 个文件` : '';
            const choice = await vscode.window.showInformationMessage(
                `将在 ${path.basename(group.cmakeFile)} 中把 ${names}${suffix}${action} ${target} 编译。`,
                '应用修改'
            );
            if (choice !== '应用修改') { return; }
        }
        const applied = await this.applyDocument(document, nextText);
        if (!applied) { return; }
        if (adding && files.some(isCppSource)) {
            const root = await this.projectRoot();
            if (root) { await prepareMixedCMake(root, true); }
        }
        this.provider.refresh();
        this.output.appendLine(`[${adding ? 'add' : 'remove'} source] target=${target}; files=${files.join(', ')}`);
        vscode.window.showInformationMessage(`已将所选 C/C++ 文件${action} CMake 配置；下次编译时生效。`);
    }

    private async createFileAndAdd(group: CMakeGroup, target: string, file: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(group.cmakeFile));
        const oldText = document.getText();
        const managedSources = readManagedSources(oldText, group.directory);
        const entries = managedSources.get(target) || new Map<string, string>();
        entries.set(normalizeFile(file), file);
        managedSources.set(target, entries);
        const body = renderSourceCommands(group.directory, managedSources);
        const nextText = addManagedBlock(removeManagedBlock(oldText, SOURCES_BEGIN, SOURCES_END), SOURCES_BEGIN, SOURCES_END, body);
        const edit = new vscode.WorkspaceEdit();
        const uri = vscode.Uri.file(file);
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(oldText.length)), nextText);
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            vscode.window.showErrorMessage(`rm_debug：创建或编辑失败：${file}`);
            return;
        }
        const saved = await document.save();
        if (!saved) {
            vscode.window.showWarningMessage(`rm_debug：CMake 文件尚未保存：${document.uri.fsPath}`);
            return;
        }
        if (isCppSource(file)) {
            const root = await this.projectRoot();
            if (root) { await prepareMixedCMake(root, true); }
        }
        this.provider.refresh();
        this.output.appendLine(`[create source] target=${target}; file=${file}`);
        vscode.window.showInformationMessage(`已创建 ${path.basename(file)} 并加入 ${target} 编译。`);
    }

    private async removeSources(node?: CMakeProjectTreeNode): Promise<void> {
        await this.provider.load();
        const allSources = this.provider.getGroups().flatMap((group) => group.sources.map((source) => ({ group, source })));
        let selected: Array<{ group: CMakeGroup; source: SourceReference }> = [];
        if (node?.source) {
            const group = this.provider.getGroups().find((item) => item.id === node.groupId);
            if (group) { selected = [{ group, source: node.source }]; }
        } else {
            const choices = allSources.map((item) => ({
                label: path.basename(item.source.file),
                description: `${item.source.target} · ${item.source.managed ? '插件管理' : path.basename(item.source.cmakeFile)}`,
                detail: item.source.file,
                item
            }));
            const picked = await vscode.window.showQuickPick(choices, {
                canPickMany: true,
                placeHolder: '选择要从编译中移除的 C/C++ 文件'
            });
            selected = (picked || []).map((choice) => choice.item);
        }
        if (!selected.length) { return; }
        const confirmation = await vscode.window.showWarningMessage(
            `将从 CMake 编译目标中移除所选 ${selected.length} 个 C/C++ 文件；源文件仍保留在磁盘。`,
            '移出编译'
        );
        if (confirmation !== '移出编译') { return; }
        const managed = selected.filter((item) => item.source.managed);
        const external = selected.filter((item) => !item.source.managed);
        if (external.length) {
            const result = await this.removeLiteralReferences(external.map((item) => item.source));
            if (result.failed.length) {
                vscode.window.showWarningMessage(
                    `以下 ${result.failed.length} 个文件由复杂或非 target_sources 的 CMake 语句管理，未自动修改：`
                    + result.failed.map((item) => path.basename(item.file)).join(', ')
                );
            }
        }
        for (const group of [...new Set(managed.map((item) => item.group))]) {
            const byTarget = new Map<string, string[]>();
            for (const item of managed.filter((entry) => entry.group.id === group.id)) {
                const files = byTarget.get(item.source.target) || [];
                files.push(item.source.file);
                byTarget.set(item.source.target, files);
            }
            for (const [target, files] of byTarget) {
                await this.mutateSources(group, target, files, false, true);
            }
        }
        this.provider.refresh();
    }

    private async removeLiteralReferences(references: SourceReference[]): Promise<{ removed: number; failed: SourceReference[] }> {
        const byFile = new Map<string, SourceReference[]>();
        for (const reference of references) {
            if (reference.commandName !== 'target_sources') { continue; }
            const items = byFile.get(reference.cmakeFile) || [];
            items.push(reference);
            byFile.set(reference.cmakeFile, items);
        }
        const failed = references.filter((reference) => reference.commandName !== 'target_sources');
        let removed = 0;
        for (const [cmakeFile, fileReferences] of byFile) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(cmakeFile));
            const original = document.getText();
            const selected = new Set(fileReferences.map((item) => `${item.target}\n${normalizeFile(item.file)}`));
            const replacements: Array<{ start: number; end: number }> = [];
            for (const command of parseCommands(original)) {
                if (command.name !== 'target_sources' || !command.args[0]) { continue; }
                const target = command.args[0].value;
                const sources = targetSourceFileArguments(command.args.slice(1));
                const matched = sources.filter((arg) => {
                    const file = resolveCMakePath(arg.value, path.dirname(cmakeFile));
                    return Boolean(file && path.extname(file).toLowerCase() === '.c' && selected.has(`${target}\n${normalizeFile(file)}`));
                });
                if (!matched.length) { continue; }
                const remaining = sources.filter((arg) => !matched.includes(arg));
                removed += matched.length;
                if (!remaining.length) {
                    let start = command.start;
                    let end = command.end;
                    while (start > 0 && (original[start - 1] === '\r' || original[start - 1] === '\n')) {
                        start--;
                    }
                    if (original[end] === '\r') { end++; }
                    if (original[end] === '\n') { end++; }
                    replacements.push({ start, end });
                } else {
                    for (const arg of matched) {
                        let start = arg.start;
                        let end = arg.end;
                        while (start > command.openParen + 1 && /\s/.test(original[start - 1])) {
                            start--;
                        }
                        if (start === arg.start) {
                            while (end < command.closeParen && /\s/.test(original[end])) {
                                end++;
                            }
                        }
                        replacements.push({ start, end });
                    }
                }
            }
            if (!replacements.length) {
                failed.push(...fileReferences);
                continue;
            }
            let updated = original;
            for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
                updated = updated.slice(0, replacement.start) + updated.slice(replacement.end);
            }
            const applied = await this.applyDocument(document, updated, false);
            if (!applied) { failed.push(...fileReferences); }
        }
        return { removed, failed };
    }

    private async addInclude(node?: CMakeProjectTreeNode): Promise<void> {
        const group = await this.groupFor(node);
        if (!group) { return; }
        const target = await this.chooseTarget(group);
        if (!target) { return; }
        const selected = await vscode.window.showOpenDialog({
            title: '选择头文件或头文件目录',
            defaultUri: vscode.Uri.file(group.directory),
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: false,
            filters: { '头文件': ['h', 'hpp'] }
        });
        if (!selected?.length) { return; }
        let directory = selected[0].fsPath;
        try {
            if (fs.statSync(directory).isFile()) { directory = path.dirname(directory); }
        } catch (_error) {
            return;
        }
        const root = await this.projectRoot();
        try {
            if (!root || !inside(fs.realpathSync(root), fs.realpathSync(directory))) {
                vscode.window.showErrorMessage('rm_debug：头文件目录必须位于当前 CMake 工程内。');
                return;
            }
        } catch (_error) {
            vscode.window.showErrorMessage(`rm_debug：无法解析头文件目录：${directory}`);
            return;
        }
        if (/[\r\n;"$]/.test(path.relative(group.directory, directory))) {
            vscode.window.showErrorMessage(`rm_debug：目录路径包含 CMake 不安全字符：${directory}`);
            return;
        }
        const visibility = group.targetKinds[target] === 'executable'
            ? 'PRIVATE'
            : group.targets.includes(target)
                ? await vscode.window.showQuickPick(['PUBLIC', 'PRIVATE'], { placeHolder: '选择头文件目录可见范围', title: 'PUBLIC：依赖该库的模块也可使用；PRIVATE：只对本目标可见' })
                : 'PRIVATE';
        if (!visibility) { return; }
        if (this.provider.getGroups().some((candidateGroup) => candidateGroup.includes.some((item) =>
            item.target === target && normalizeFile(item.directory) === normalizeFile(directory)
        ))) {
            vscode.window.showInformationMessage('该头文件目录已经存在。');
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(group.cmakeFile));
        const oldText = document.getText();
        const existing = new Map<string, { target: string; directory: string; visibility: string }>();
        const block = managedBlock(oldText, INCLUDES_BEGIN, INCLUDES_END) || '';
        for (const command of parseCommands(block)) {
            if (command.name !== 'target_include_directories' || !command.args[0]) { continue; }
            const managedTarget = command.args[0].value;
            let currentVisibility = 'PRIVATE';
            for (const arg of command.args.slice(1)) {
                if (SCOPE_WORDS.has(arg.value.toUpperCase())) {
                    currentVisibility = arg.value.toUpperCase();
                    continue;
                }
                if (INCLUDE_OPTIONS.has(arg.value.toUpperCase())) { continue; }
                const resolved = resolveCMakePath(arg.value, group.directory);
                if (resolved) {
                    existing.set(`${managedTarget}\n${normalizeFile(resolved)}`, {
                        target: managedTarget, directory: resolved, visibility: currentVisibility
                    });
                }
            }
        }
        existing.set(`${target}\n${normalizeFile(directory)}`, { target, directory, visibility });
        const body = renderIncludeCommands(group.directory, existing);
        const nextText = addManagedBlock(removeManagedBlock(oldText, INCLUDES_BEGIN, INCLUDES_END), INCLUDES_BEGIN, INCLUDES_END, body);
        const choice = await vscode.window.showInformationMessage(`将 ${directory} 作为 ${target} 的 ${visibility} 头文件目录。`, '应用修改');
        if (choice !== '应用修改') { return; }
        if (!await this.applyDocument(document, nextText)) { return; }
        this.provider.refresh();
        this.output.appendLine(`[add include] target=${target}; visibility=${visibility}; directory=${directory}`);
    }

    private async removeInclude(node?: CMakeProjectTreeNode): Promise<void> {
        await this.provider.load();
        let include = node?.include;
        let group = node?.groupId ? this.provider.getGroups().find((item) => item.id === node.groupId) : undefined;
        if (!include || !group) {
            const entries = this.provider.getGroups().flatMap((item) => item.includes.map((directory) => ({ group: item, include: directory })));
            const picked = await vscode.window.showQuickPick(entries.map((item) => ({
                label: item.include.directory, description: `${item.include.target} · ${path.basename(item.include.cmakeFile)}`, item
            })), { placeHolder: '选择要移除的头文件目录' });
            group = picked?.item.group;
            include = picked?.item.include;
        }
        if (!group || !include) { return; }
        if (!include.managed) {
            vscode.window.showWarningMessage(`此路径由原有 CMake 命令管理。请在 ${include.cmakeFile} 中手动移除。`);
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(group.cmakeFile));
        const oldText = document.getText();
        const block = managedBlock(oldText, INCLUDES_BEGIN, INCLUDES_END) || '';
        const directories = new Map<string, { target: string; directory: string; visibility: string }>();
        for (const command of parseCommands(block)) {
            if (command.name !== 'target_include_directories' || !command.args[0]) { continue; }
            const managedTarget = command.args[0].value;
            let currentVisibility = 'PRIVATE';
            for (const arg of command.args.slice(1)) {
                if (SCOPE_WORDS.has(arg.value.toUpperCase())) {
                    currentVisibility = arg.value.toUpperCase();
                    continue;
                }
                if (INCLUDE_OPTIONS.has(arg.value.toUpperCase())) { continue; }
                const resolved = resolveCMakePath(arg.value, group.directory);
                if (resolved && !(managedTarget === include.target && normalizeFile(resolved) === normalizeFile(include.directory))) {
                    directories.set(`${managedTarget}\n${normalizeFile(resolved)}`, {
                        target: managedTarget, directory: resolved, visibility: currentVisibility
                    });
                }
            }
        }
        let nextText = removeManagedBlock(oldText, INCLUDES_BEGIN, INCLUDES_END);
        if (directories.size) {
            const body = renderIncludeCommands(group.directory, directories);
            nextText = addManagedBlock(nextText, INCLUDES_BEGIN, INCLUDES_END, body);
        }
        const choice = await vscode.window.showInformationMessage(`从 ${include.target} 的头文件路径中移除 ${include.directory}。`, '应用修改');
        if (choice !== '应用修改') { return; }
        if (!await this.applyDocument(document, nextText)) { return; }
        this.provider.refresh();
        this.output.appendLine(`[remove include] target=${include.target}; directory=${include.directory}`);
    }

    private async createGroup(node?: CMakeProjectTreeNode): Promise<void> {
        const parent = await this.groupFor(node);
        if (!parent) { return; }
        const name = await vscode.window.showInputBox({
            prompt: '新建物理文件夹与 CMakeLists.txt',
            placeHolder: '例如 pid',
            validateInput: (value) => {
                const candidate = value.trim();
                if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(candidate) || candidate === '..' || candidate.endsWith('.') || reservedWindowsName(candidate)) {
                    return '请输入有效的单层文件夹名，不要使用路径分隔符或 Windows 保留名称。';
                }
                const selectedDirectory = path.join(parent.directory, candidate);
                if (fs.existsSync(selectedDirectory)
                    && (!fs.statSync(selectedDirectory).isDirectory()
                        || fs.existsSync(path.join(selectedDirectory, 'CMakeLists.txt')))) {
                    return '目标已存在且包含文件，或不是目录。';
                }
                return undefined;
            }
        });
        if (!name) { return; }
        const target = await this.chooseTarget(parent);
        if (!target) { return; }
        const directory = path.join(parent.directory, name.trim());
        const root = await this.projectRoot();
        try {
            if (!root || !inside(fs.realpathSync(root), fs.realpathSync(parent.directory))) {
                vscode.window.showErrorMessage('rm_debug：分组父目录必须位于当前 CMake 工程内。');
                return;
            }
            if (fs.existsSync(directory) && !inside(fs.realpathSync(root), fs.realpathSync(directory))) {
                vscode.window.showErrorMessage('rm_debug：不能在工程目录之外创建分组。');
                return;
            }
        } catch (_error) {
            vscode.window.showErrorMessage(`rm_debug：无法校验分组路径：${directory}`);
            return;
        }
        const parentDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(parent.cmakeFile));
        const oldText = parentDocument.getText();
        const relative = path.relative(parent.directory, directory).replace(/\\/g, '/');
        const existing = new Set<string>();
        for (const child of parent.subdirectories) {
            existing.add(normalizeFile(child));
        }
        const alreadyIncluded = existing.has(normalizeFile(directory));
        if (alreadyIncluded && fs.existsSync(path.join(directory, 'CMakeLists.txt'))) {
            vscode.window.showInformationMessage('该 CMake 子分组已经存在。');
            return;
        }
        const block = managedBlock(oldText, SUBDIRS_BEGIN, SUBDIRS_END) || '';
        const managed = new Set<string>();
        for (const command of parseCommands(block)) {
            if (command.name === 'add_subdirectory' && command.args[0]) { managed.add(command.args[0].value); }
        }
        if (!alreadyIncluded) { managed.add(relative); }
        const body = [...managed].sort().map((item) => `add_subdirectory(${item})`).join('\n');
        const nextParent = alreadyIncluded
            ? oldText
            : addManagedBlock(removeManagedBlock(oldText, SUBDIRS_BEGIN, SUBDIRS_END), SUBDIRS_BEGIN, SUBDIRS_END, body);
        const childText = `# rm_debug target: ${target}\n# ${path.basename(directory)} CMake 分组\n`;
        const confirmed = await vscode.window.showInformationMessage(
            `创建分组 ${relative}，由 ${target} 编译。目录内已有的 .c 不会自动加入。`, '创建分组'
        );
        if (confirmed !== '创建分组') { return; }
        const directoryExisted = fs.existsSync(directory);
        try {
            await fs.promises.mkdir(directory, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`rm_debug：无法创建分组目录：${String(error)}`);
            return;
        }
        const childUri = vscode.Uri.file(path.join(directory, 'CMakeLists.txt'));
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(childUri, { overwrite: false, ignoreIfExists: false });
        edit.insert(childUri, new vscode.Position(0, 0), childText);
        edit.replace(parentDocument.uri, new vscode.Range(parentDocument.positionAt(0), parentDocument.positionAt(oldText.length)), nextParent);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            if (!directoryExisted) {
                try {
                    await fs.promises.rmdir(directory);
                } catch (_error) {
                    /* Keep any file created by the user. */
                }
            }
            vscode.window.showErrorMessage(`rm_debug：创建 CMake 分组失败：${directory}`);
            return;
        }
        const childDocument = await vscode.workspace.openTextDocument(childUri);
        const childSaved = await childDocument.save();
        const parentSaved = await parentDocument.save();
        if (!childSaved || !parentSaved) {
            vscode.window.showWarningMessage('rm_debug：分组已写入编辑器，但至少一个 CMakeLists.txt 尚未保存。');
        }
        this.provider.refresh();
        this.output.appendLine(`[create group] parent=${parent.cmakeFile}; directory=${directory}; target=${target}`);
        vscode.window.showInformationMessage(`已创建 CMake 分组 ${relative}。`);
    }

    private async applyDocument(document: vscode.TextDocument, text: string, refresh = false): Promise<boolean> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage(`rm_debug：未能编辑 ${document.uri.fsPath}`);
            return false;
        }
        const saved = await document.save();
        if (refresh) { this.provider.refresh(); }
        this.output.appendLine(`[edit] ${document.uri.fsPath}`);
        return saved;
    }
}
