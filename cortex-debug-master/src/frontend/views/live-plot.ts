import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LivePlotSample, LivePlotStatus, LiveVariableNode, LiveWatchTreeProvider } from './live-watch';

interface PlotSeries {
    id: string;
    label: string;
    color: string;
}

const COLORS = ['#4da3ff', '#f3ad45', '#50c7a8', '#e178be', '#b3a1ff', '#e77967', '#a6c95b', '#63c9df'];
const MAX_HISTORY_MS = 5 * 60 * 1000;
const MAX_FRAMES = 6000;

export class LivePlotPanel implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly series = new Map<string, PlotSeries>();
    private readonly history: LivePlotSample[] = [];
    private readonly pendingSamples: LivePlotSample[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private sessionId: string | undefined;
    private status: LivePlotStatus['status'] = 'stopped';
    private serialInfo = '';
    private paused = false;
    private ready = false;
    private disposed = false;

    constructor(
        context: vscode.ExtensionContext,
        private readonly provider: LiveWatchTreeProvider | undefined,
        private readonly onClosed: () => void,
        private readonly source: 'live-watch' | 'serial' = 'live-watch',
        private readonly onSelectSerialChannels?: () => void
    ) {
        this.sessionId = source === 'serial' ? 'serial' : LiveWatchTreeProvider.session?.id;
        this.panel = vscode.window.createWebviewPanel(
            'rm-debug.livePlot', source === 'serial' ? 'rm_debug: Serial Plot' : 'rm_debug: Live Plot · DAPLink', vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, enableCommandUris: false }
        );
        const nonce = crypto.randomBytes(16).toString('hex');
        const template = fs.readFileSync(path.join(context.extensionPath, 'resources', 'live-plot.html'), 'utf8');
        this.subscriptions.push(
            this.panel.onDidDispose(() => this.dispose()),
            this.panel.webview.onDidReceiveMessage((message: { type?: string; id?: string }) => this.onMessage(message)),
            this.panel.onDidChangeViewState(() => this.sendState())
        );
        if (provider) {
            this.subscriptions.push(
                provider.onDidCompleteSample((sample) => this.onSample(sample)),
                provider.onDidChangePlotStatus((event) => this.onStatus(event))
            );
        }
        this.panel.webview.html = template.replace(/\$\{nonce\}/g, nonce);
    }

    public reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    public add(node: LiveVariableNode): void {
        this.addSeries(node.getPlotPath(), node.getPlotLabel());
        this.reveal();
    }

    public addSeries(id: string, label: string): void {
        if (!this.series.has(id)) {
            this.series.set(id, {
                id,
                label,
                color: COLORS[this.series.size % COLORS.length]
            });
            this.provider?.setPlotPaths(new Set(this.series.keys()));
            this.sendState();
        }
    }

    public addSerialSample(timestampMs: number, actualHz: number | undefined, values: Record<string, number>): void {
        this.onSample({ sessionId: 'serial', timestampMs, actualHz, values });
    }

    public setSerialSeries(channels: Array<{ id: string; label: string }>): void {
        this.series.clear();
        for (const channel of channels) {
            this.series.set(channel.id, { ...channel, color: COLORS[this.series.size % COLORS.length] });
        }
        this.history.length = 0;
        this.sendState();
    }

    public setSerialInfo(info: string): void {
        this.serialInfo = info;
        if (this.ready) { void this.panel.webview.postMessage({ type: 'serialInfo', info }); }
    }

    public setSerialStatus(status: LivePlotStatus['status']): void {
        this.onStatus({ sessionId: 'serial', status });
    }

    private onMessage(message: { type?: string; id?: string }): void {
        if (message?.type === 'ready') {
            this.ready = true;
            this.sendState();
        } else if (message?.type === 'pause') {
            this.paused = true;
            this.appendGap();
            this.sendState();
        } else if (message?.type === 'resume') {
            this.paused = false;
            this.sendState();
        } else if (message?.type === 'clear') {
            this.history.length = 0;
            this.sendState();
        } else if (message?.type === 'remove' && typeof message.id === 'string') {
            this.series.delete(message.id);
            for (const frame of this.history) {
                delete frame.values[message.id];
            }
            this.provider?.setPlotPaths(new Set(this.series.keys()));
            this.sendState();
        } else if (message?.type === 'chooseSerialChannels' && this.source === 'serial') {
            this.onSelectSerialChannels?.();
        }
    }

    private onStatus(event: LivePlotStatus): void {
        if (this.sessionId !== event.sessionId) {
            this.sessionId = event.sessionId;
            this.history.length = 0;
        }
        this.status = event.status;
        if (event.status !== 'running') { this.appendGap(); }
        this.sendState();
    }

    private appendGap(): void {
        if (!this.sessionId || this.history.length === 0 || this.series.size === 0) { return; }
        const values: Record<string, null> = {};
        for (const id of this.series.keys()) {
            values[id] = null;
        }
        this.history.push({
            sessionId: this.sessionId,
            timestampMs: Math.max(Date.now(), this.history[this.history.length - 1].timestampMs + 1),
            actualHz: undefined,
            values
        });
    }

    private onSample(sample: LivePlotSample): void {
        if (this.series.size === 0 || this.paused) { return; }
        if (this.sessionId !== sample.sessionId) {
            this.sessionId = sample.sessionId;
            this.history.length = 0;
        }
        if (this.history.length && sample.timestampMs <= this.history[this.history.length - 1].timestampMs) { return; }
        this.status = 'running';
        this.history.push(sample);
        const cutoff = sample.timestampMs - MAX_HISTORY_MS;
        while (this.history.length > MAX_FRAMES || (this.history.length > 1 && this.history[0].timestampMs < cutoff)) {
            this.history.shift();
        }
        if (this.ready) {
            this.pendingSamples.push(sample);
            if (!this.flushTimer) {
                this.flushTimer = setTimeout(() => {
                    this.flushTimer = undefined;
                    if (this.disposed || !this.ready) { return; }
                    const samples = this.pendingSamples.splice(0);
                    if (samples.length) { void this.panel.webview.postMessage({ type: 'sampleBatch', samples }); }
                }, 33);
            }
        }
    }

    private sendState(): void {
        if (!this.ready || this.disposed) { return; }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.pendingSamples.length = 0;
        void this.panel.webview.postMessage({
            type: 'state',
            series: [...this.series.values()],
            history: this.history,
            paused: this.paused,
            status: this.status,
            source: this.source,
            serialInfo: this.serialInfo
        });
    }

    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.provider?.setPlotPaths(new Set<string>());
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.panel.dispose();
        this.onClosed();
    }
}
