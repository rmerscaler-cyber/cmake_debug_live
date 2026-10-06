import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs in an isolated VS Code test window with the installed C/C++ language service. */
export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension('rm-test.rm-debug-search-smoke');
    const search = await extension.activate();
    const root = process.env.RM_SEARCH_HOST_FIXTURE;
    const main = vscode.Uri.file(path.join(root, 'alpha/firmware/use.cpp'));
    const definitions = path.join(root, 'alpha/firmware/defs.cpp');
    const other = path.join(root, 'beta/unrelated.cpp');
    const ignored = path.join(root, 'alpha/firmware/ignored/extra.cpp');
    const document = await vscode.workspace.openTextDocument(main);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(1, document.lineAt(1).text.indexOf('rm_search_value'));
    editor.selection = new vscode.Selection(position, position);
    const cpp = vscode.extensions.getExtension('ms-vscode.cpptools');
    assert.ok(cpp, 'the integration check requires an installed C/C++ extension');
    await cpp.activate();
    await vscode.commands.executeCommand('C_Cpp.RescanWorkspace');
    let locations: vscode.Location[] = [];
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        locations = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', main, position);
        if (locations?.some((location) => location.uri.fsPath === definitions)) { break; }
        await delay(1000);
    }
    assert.ok(locations.some((location) => location.uri.fsPath === definitions), 'real C/C++ definition lookup must cross translation units');
    const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', main, position);
    assert.ok(references.some((location) => location.uri.fsPath === main.fsPath), 'reference provider must include the actual use');
    assert.ok(!references.some((location) => location.uri.fsPath === other), 'a different local variable with the same name must not count as a reference');

    await search.search('definition', 'project');
    let files = search.results.getChildren();
    assert.ok(files.some((file) => file.uri.fsPath === definitions), 'plugin definition tree must include the cross-file target');
    const target = files.find((file) => file.uri.fsPath === definitions).children[0].location;
    await vscode.commands.executeCommand('rm-debug.search.openResult', target);
    assert.strictEqual(vscode.window.activeTextEditor.document.uri.fsPath, definitions);
    assert.strictEqual(vscode.window.activeTextEditor.selection.start.line, target.range.start.line);
    await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);
    await search.search('references', 'workspace');
    files = search.results.getChildren();
    assert.ok(files.some((file) => file.uri.fsPath === main.fsPath));
    assert.ok(!files.some((file) => file.uri.fsPath === other));

    // Exercise the real sidebar search rather than just checking the command arguments.
    const clipboard = await vscode.env.clipboard.readText();
    try {
        for (const scope of ['workspace', 'file', 'project']) {
            await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(position, position);
            const operation = search.search('text', scope);
            await delay(500);
            await vscode.commands.executeCommand('quickInput.accept');
            await operation;
            let copied = '';
            for (let attempt = 0; attempt < 10; attempt++) {
                await delay(500);
                await vscode.commands.executeCommand('search.action.copyAll');
                copied = await vscode.env.clipboard.readText();
                if (copied.includes('use.cpp')) { break; }
            }
            assert.ok(copied.includes('use.cpp'), `native ${scope} search must show the active file`);
            assert.strictEqual(copied.includes('unrelated.cpp'), scope === 'workspace', 'workspace search must include the second root');
            assert.strictEqual(copied.includes('extra.cpp'), scope !== 'file', 'whole-project text search must include ignored source files');
            assert.strictEqual(copied.includes('defs.cpp'), scope !== 'file', 'file scope must not retain other project results');
        }
    } finally { await vscode.env.clipboard.writeText(clipboard); }
    console.log(`Real VS Code host: cross-file definitions, ${references.length} true references, exact jumps and native search scopes passed.`);
}
