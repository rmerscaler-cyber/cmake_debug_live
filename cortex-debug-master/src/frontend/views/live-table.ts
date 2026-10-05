import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LiveValuesSample, LiveWatchTreeProvider } from './live-watch';
import { LiveDisplayMode } from '../../live-matrix';

type ViewMessage = {
    type?: string;
    path?: string;
    action?: string;
    expanded?: boolean;
    value?: string;
    sessionId?: string;
    requestId?: number;
    mode?: LiveDisplayMode;
};

/** The Live Watch sidebar uses the same sample stream as the fast value table. */
export class LiveTableViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private ready = false;
    private samplingVisible = false;
    private latestSample: LiveValuesSample | undefined;
    private pendingReveal: string | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly provider: LiveWatchTreeProvider
    ) {
        this.subscriptions.push(
            provider.onDidUpdateValues((sample) => {
                this.latestSample = sample;
                this.sendSample(sample);
            }),
            provider.onDidChangeTreeData(() => this.sendSnapshot())
        );
    }

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.ready = false;
        view.webview.options = { enableScripts: true, enableCommandUris: false };
        const nonce = crypto.randomBytes(16).toString('hex');
        const template = fs.readFileSync(path.join(this.context.extensionPath, 'resources', 'live-table.html'), 'utf8');
        view.webview.html = template.replace(/\$\{nonce\}/g, nonce);
        this.setSamplingVisible(view.visible);
        const messages = view.webview.onDidReceiveMessage((message: ViewMessage) => {
            void this.handleMessage(message);
        });
        const visibility = view.onDidChangeVisibility(() => {
            this.setSamplingVisible(view.visible);
            if (view.visible) { this.sendSnapshot(); }
        });
        view.onDidDispose(() => {
            messages.dispose();
            visibility.dispose();
            this.view = undefined;
            this.ready = false;
            this.setSamplingVisible(false);
        });
    }

    public async reveal(path?: string): Promise<void> {
        this.pendingReveal = path;
        await vscode.commands.executeCommand('cortex-debug.liveWatch.focus');
        if (path && this.ready) {
            void this.view?.webview.postMessage({ type: 'reveal', path });
            this.pendingReveal = undefined;
        }
    }

    private async handleMessage(message: ViewMessage): Promise<void> {
        if (message?.type === 'ready') {
            this.ready = true;
            this.sendSnapshot();
            if (this.pendingReveal) {
                void this.view?.webview.postMessage({ type: 'reveal', path: this.pendingReveal });
                this.pendingReveal = undefined;
            }
            return;
        }
        const path = typeof message?.path === 'string' ? message.path : '';
        if (message?.type === 'setDisplayMode' && ['auto', 'tree', 'matrix'].includes(message.mode)) {
            this.provider.setViewDisplayMode(path, message.mode);
            this.sendSnapshot();
            return;
        }
        if (message?.type === 'setValue' && typeof message.value === 'string'
            && typeof message.sessionId === 'string' && Number.isSafeInteger(message.requestId)) {
            try {
                const result = await this.provider.setViewValue(path, message.value, message.sessionId);
                void this.view?.webview.postMessage({ type: 'writeResult', requestId: message.requestId,
                    sessionId: message.sessionId, path, success: true, ...result });
            } catch (error) {
                void this.view?.webview.postMessage({ type: 'writeResult', requestId: message.requestId,
                    sessionId: message.sessionId, path, success: false, error: String(error) });
            }
            return;
        }
        if (message?.type === 'setExpanded' && typeof message.expanded === 'boolean') {
            this.provider.setViewExpanded(path, message.expanded);
            this.sendSnapshot();
            return;
        }
        if (message?.type !== 'action') { return; }
        if (message.action === 'add') {
            await vscode.commands.executeCommand('cortex-debug.liveWatch.addExpr');
            return;
        }
        const node = this.provider.findViewNode(path);
        if (!node) { return; }
        if (message.action === 'copy') {
            const hexadecimal = !vscode.workspace.getConfiguration('cortex-debug')
                .get('variableUseNaturalFormat', true);
            const row = node.getViewRow(0, hexadecimal);
            const matrix = row.matrix;
            const text = matrix?.values.length
                ? Array.from({ length: matrix.rows }, (_, index) =>
                        matrix.values.slice(index * matrix.columns, (index + 1) * matrix.columns).join('\t')).join('\n')
                : row.value;
            await vscode.env.clipboard.writeText(text);
            return;
        }
        if (message.action === 'matrixShape') {
            await this.provider.setViewMatrixDimensions(path);
            this.sendSnapshot();
            return;
        }
        const commands: Record<string, string> = {
            edit: 'cortex-debug.liveWatch.editExpr',
            remove: 'cortex-debug.liveWatch.removeExpr',
            up: 'cortex-debug.liveWatch.moveUp',
            down: 'cortex-debug.liveWatch.moveDown',
            all: 'rm-debug.liveWatch.toggleMonitorAll',
            plot: 'rm-debug.livePlot.add',
            serialPlot: 'rm-debug.serialPlot.add',
            goto: 'rm-debug.liveWatch.gotoFunctionTarget',
            more: 'rm-debug.liveWatch.loadMore'
        };
        const command = commands[message.action || ''];
        if (command) { await vscode.commands.executeCommand(command, node); }
    }

    private sendSnapshot(): void {
        if (!this.ready || !this.view) { return; }
        const sample = this.latestSample;
        this.sendSample({
            sessionId: LiveWatchTreeProvider.session?.id || '',
            timestampMs: sample?.timestampMs || Date.now(),
            targetHz: this.provider.getSamplingRate(),
            actualHz: sample?.actualHz,
            rows: this.provider.getViewRows()
        });
    }

    private sendSample(sample: LiveValuesSample): void {
        if (this.ready && this.view?.visible) {
            void this.view.webview.postMessage({ type: 'sample', ...sample });
        }
    }

    private setSamplingVisible(visible: boolean): void {
        if (this.samplingVisible === visible) { return; }
        this.samplingVisible = visible;
        LiveWatchTreeProvider.notifyValuePanel(visible);
    }

    public dispose(): void {
        this.setSamplingVisible(false);
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
    }
}
