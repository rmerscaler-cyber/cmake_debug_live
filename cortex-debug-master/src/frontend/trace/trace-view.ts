import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import type { SymbolInformation } from '../../symbols';

const TRACE_RING_CAPACITY = 16384;
const TRACE_CONTROL_WORDS = 4;
const TRACE_RING_TICK_MS = 25;
const TRACE_STATUS_TICK_MS = 1000;

interface TraceViewMessage {
    type?: string;
    action?: string;
}

interface TraceFunctionRow {
    name: string;
    address: number;
    samples: number;
}

interface TraceAddressRow {
    address: number;
    samples: number;
    functionName?: string;
}

interface TraceSnapshot {
    totalPcSamples: number;
    mappedSamples: number;
    unmappedSamples: number;
    droppedSamples: number;
    omittedAddressSamples: number;
    functions: TraceFunctionRow[];
    addresses: TraceAddressRow[];
}

interface TraceSessionSummary extends TraceSnapshot {
    mode: 'swo-pc-sampling';
    quality: 'sampled';
    startedAt: string;
    endedAt?: string;
    durationMs: number;
    averagePcSamplesPerSecond: number;
    sleepSamples: number;
    gapCount: number;
    gapReasons: Record<string, number>;
    elf: string;
    elfSha256: string;
    elfHashStatus: 'ok' | 'unavailable';
    target: string;
    probe: string;
    swoSource: string;
    coverage: {
        available: false;
        lineCoverage: false;
        instructionCoverage: false;
        reason: string;
    };
}

interface WorkerMessage {
    type: 'snapshot' | 'export' | 'final' | 'error';
    snapshot?: TraceSnapshot;
    requestId?: number;
    message?: string;
}

/**
 * Passive sink called by the existing SWO decoder. It must not issue debugger
 * requests or wait for the worker; the hot path only writes a fixed ring slot.
 */
export interface TraceSampleSink {
    setFunctionSymbols(sessionId: string, symbols: SymbolInformation[]): void;
    sourceConnection(sessionId: string, connected: boolean): void;
    pcSample(sessionId: string, pc: number): void;
    sleepSample(sessionId: string): void;
    gap(sessionId: string, reason: string): void;
}

interface TraceCapture {
    session: vscode.DebugSession;
    args: any;
    configured: boolean;
    sourceReady: boolean;
    symbols: SymbolInformation[];
    symbolRanges?: SharedArrayBuffer;
    symbolsReady: boolean;
    terminated: boolean;
    worker?: Worker;
    ring?: Int32Array;
    writeIndex: number;
    recording: boolean;
    stopping: boolean;
    startedAt?: number;
    sleepSamples: number;
    gapCount: number;
    gapReasons: Record<string, number>;
    latest?: TraceSnapshot;
    summary?: TraceSessionSummary;
    stopPromise?: Promise<TraceSnapshot>;
    exportRequest?: { resolve: (value: TraceSnapshot) => void; reject: (error: Error) => void };
    exportRequestId: number;
}

/** Independent Trace view and capture state. Live Watch does not call this class. */
export class TraceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, TraceSampleSink {
    private view: vscode.WebviewView | undefined;
    private ready = false;
    private activeSessionId = '';
    private captures = new Map<string, TraceCapture>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.ready = false;
        view.webview.options = { enableScripts: true, enableCommandUris: false };
        const nonce = crypto.randomBytes(16).toString('hex');
        const template = fs.readFileSync(path.join(this.context.extensionPath, 'resources', 'trace-view.html'), 'utf8');
        view.webview.html = template.replace(/\$\{nonce\}/g, nonce);
        const messages = view.webview.onDidReceiveMessage((message: TraceViewMessage) => {
            void this.handleMessage(message);
        });
        view.onDidChangeVisibility(() => {
            if (view.visible) { this.sendSnapshot(); }
        });
        view.onDidDispose(() => {
            messages.dispose();
            this.view = undefined;
            this.ready = false;
        });
    }

    public setDebugSession(session: vscode.DebugSession, args: any): void {
        this.activeSessionId = session.id;
        for (const [id, previous] of this.captures) {
            if (id !== session.id && !previous.recording && !previous.stopping) { this.captures.delete(id); }
        }
        const existing = this.captures.get(session.id);
        if (existing) {
            existing.args = args;
            existing.configured = this.hasPCSamplingConfig(args);
        } else {
            this.captures.set(session.id, {
                session,
                args,
                configured: this.hasPCSamplingConfig(args),
                sourceReady: false,
                symbols: [],
                terminated: false,
                symbolsReady: false,
                recording: false,
                stopping: false,
                writeIndex: 0,
                sleepSamples: 0,
                gapCount: 0,
                gapReasons: {},
                exportRequestId: 0
            });
        }
        this.sendSnapshot();
    }

    public activateSession(session: vscode.DebugSession | undefined): void {
        if (session?.type === 'cortex-debug' && this.captures.has(session.id)) {
            this.activeSessionId = session.id;
        } else {
            const previous = this.captures.get(this.activeSessionId);
            if (!previous?.summary && !previous?.recording && !previous?.stopping) { this.activeSessionId = ''; }
        }
        this.sendSnapshot();
    }

    public setSWOSourceReady(sessionId: string, ready: boolean, args?: any): void {
        const capture = this.captures.get(sessionId);
        if (!capture) { return; }
        if (args) {
            capture.args = args;
            capture.configured = this.hasPCSamplingConfig(args);
        }
        capture.sourceReady = ready;
        this.sendSnapshot();
    }

    public sourceConnection(sessionId: string, connected: boolean): void {
        const capture = this.captures.get(sessionId);
        if (!capture) { return; }
        capture.sourceReady = connected;
        this.sendSnapshot();
    }

    public setFunctionSymbols(sessionId: string, symbols: SymbolInformation[]): void {
        const capture = this.captures.get(sessionId);
        if (!capture) { return; }
        capture.symbols = symbols || [];
        capture.symbolsReady = true;
        this.sendSnapshot();
    }

    public pcSample(sessionId: string, pc: number): void {
        const capture = this.captures.get(sessionId);
        if (!capture?.recording || !capture.ring) { return; }
        const ring = capture.ring;
        const write = capture.writeIndex;
        const read = Atomics.load(ring, 1);
        const next = write + 1 === TRACE_RING_CAPACITY ? 0 : write + 1;
        if (next === read) {
            Atomics.add(ring, 2, 1);
            return;
        }
        ring[TRACE_CONTROL_WORDS + write] = pc >>> 0;
        capture.writeIndex = next;
        Atomics.store(ring, 0, next);
    }

    public sleepSample(sessionId: string): void {
        const capture = this.captures.get(sessionId);
        if (capture?.recording && capture.ring) { Atomics.add(capture.ring, 3, 1); }
    }

    public gap(sessionId: string, reason: string): void {
        const capture = this.captures.get(sessionId);
        if (!capture?.recording) { return; }
        capture.gapCount++;
        capture.gapReasons[reason] = (capture.gapReasons[reason] || 0) + 1;
    }

    public startForActiveSession(): void {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'cortex-debug') {
            void vscode.window.showInformationMessage('请先启动一个 Cortex-Debug 调试会话。');
            return;
        }
        this.activeSessionId = session.id;
        const capture = this.captures.get(session.id);
        if (!capture) {
            void vscode.window.showInformationMessage('Trace 正在等待调试会话配置。');
            return;
        }
        if (capture.stopping) {
            void vscode.window.showInformationMessage('Trace 正在收尾，请稍后再开始下一次采集。');
            return;
        }
        if (!capture.configured || !capture.sourceReady || !capture.symbolsReady) {
            void vscode.window.showWarningMessage(
                !capture.configured || !capture.sourceReady
                    ? '当前会话没有可用的 SWO PC 采样。请在 launch.json 中启用 swoConfig.enabled 和 swoConfig.profile，配置 SWO 时钟与数据 source 后重新启动调试。Trace 不会向 GDB/DAP 发送读取请求。'
                    : 'Trace 正在等待 ELF 函数符号。稍后再开始采集。'
            );
            this.sendSnapshot();
            return;
        }
        if (capture.recording) { return; }
        if (capture.worker) { return; }
        capture.latest = undefined;
        capture.summary = undefined;
        capture.sleepSamples = 0;
        capture.gapCount = 0;
        capture.gapReasons = {};
        capture.startedAt = Date.now();
        capture.recording = true;

        try {
            const shared = new SharedArrayBuffer((TRACE_CONTROL_WORDS + TRACE_RING_CAPACITY) * Int32Array.BYTES_PER_ELEMENT);
            capture.ring = new Int32Array(shared);
            capture.writeIndex = 0;
            if (!capture.symbolRanges) {
                capture.symbolRanges = new SharedArrayBuffer(capture.symbols.length * 2 * Uint32Array.BYTES_PER_ELEMENT);
                const symbolRanges = new Uint32Array(capture.symbolRanges);
                for (let index = 0; index < capture.symbols.length; index++) {
                    symbolRanges[index * 2] = capture.symbols[index].address;
                    symbolRanges[index * 2 + 1] = capture.symbols[index].length;
                }
            }
            const worker = new Worker(this.getWorkerSource(), { eval: true, workerData: {
                shared,
                capacity: TRACE_RING_CAPACITY,
                controlWords: TRACE_CONTROL_WORDS,
                symbolRanges: capture.symbolRanges,
                symbolCount: capture.symbols.length
            } });
            capture.worker = worker;
            worker.on('message', (message: WorkerMessage) => {
                if (capture.worker === worker) { this.onWorkerMessage(capture, message); }
            });
            worker.on('error', (error: Error) => {
                if (capture.worker !== worker) { return; }
                capture.recording = false;
                capture.stopping = true;
                capture.latest = undefined;
                if (capture.exportRequest) {
                    capture.exportRequest.reject(error);
                    capture.exportRequest = undefined;
                }
                void vscode.window.showErrorMessage(`Trace 后台分析器错误：${error.message}`);
                this.sendSnapshot();
            });
            worker.on('exit', () => {
                if (capture.worker !== worker) { return; }
                if (capture.recording) {
                    capture.recording = false;
                    capture.stopping = true;
                    void vscode.window.showErrorMessage('Trace 后台分析器意外退出；当前采集已停止。');
                }
                if (capture.exportRequest) {
                    capture.exportRequest.reject(new Error('Trace worker stopped before returning its report.'));
                    capture.exportRequest = undefined;
                }
                capture.worker = undefined;
                capture.ring = undefined;
                capture.stopping = false;
                this.sendSnapshot();
            });
        } catch (error) {
            capture.recording = false;
            capture.worker = undefined;
            capture.ring = undefined;
            void vscode.window.showErrorMessage(`无法启动 Trace 后台分析器：${String(error)}`);
        }
        this.sendSnapshot();
    }

    public stopForActiveSession(): void {
        const capture = this.captures.get(this.activeSessionId);
        if (capture) { this.stopCapture(capture, true); }
    }

    public async exportForActiveSession(): Promise<void> {
        const capture = this.captures.get(this.activeSessionId);
        if (!capture) {
            void vscode.window.showInformationMessage('当前没有可导出的 Trace 结果。');
            return;
        }
        try {
            let snapshot = capture.latest;
            if (capture.stopping && capture.stopPromise) {
                snapshot = await capture.stopPromise;
            } else if (capture.recording && capture.worker) {
                snapshot = await this.requestWorkerSnapshot(capture);
            }
            if (!snapshot && capture.summary) { snapshot = capture.summary; }
            if (!snapshot) {
                void vscode.window.showInformationMessage('当前没有 Trace 样本。');
                return;
            }
            const format = await vscode.window.showQuickPick([
                { label: 'JSON', description: '完整报告和采样元数据', value: 'json' },
                { label: 'CSV', description: '适用于表格工具的热点明细', value: 'csv' }
            ], { placeHolder: '选择 Trace 报告格式' });
            if (!format) { return; }
            const jsonUri = await vscode.window.showSaveDialog({
                saveLabel: '导出 Trace 报告',
                defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', `trace-profile.${format.value}`)),
                filters: format.value === 'csv' ? { CSV: ['csv'] } : { 'Trace JSON': ['json'] }
            });
            if (!jsonUri) { return; }
            const report = this.createSummary(capture, snapshot);
            report.elfSha256 = await this.hashElf(report.elf);
            report.elfHashStatus = report.elfSha256 ? 'ok' : 'unavailable';
            if (format.value === 'csv') {
                const csv = this.toCsv(report);
                await fs.promises.writeFile(jsonUri.fsPath, csv, 'utf8');
            } else {
                await fs.promises.writeFile(jsonUri.fsPath, JSON.stringify(report, null, 2), 'utf8');
            }
            void vscode.window.showInformationMessage(`Trace 报告已导出：${jsonUri.fsPath}`);
        } catch (error) {
            void vscode.window.showErrorMessage(`导出 Trace 报告失败：${String(error)}`);
        }
    }

    public clearForActiveSession(): void {
        const capture = this.captures.get(this.activeSessionId);
        if (!capture || capture.recording || capture.stopping) { return; }
        capture.latest = undefined;
        capture.summary = undefined;
        capture.sleepSamples = 0;
        capture.gapCount = 0;
        capture.gapReasons = {};
        this.sendSnapshot();
    }

    public sessionTerminated(session: vscode.DebugSession): void {
        const capture = this.captures.get(session.id);
        if (capture) {
            capture.terminated = true;
            this.stopCapture(capture, true);
            capture.sourceReady = false;
            if (!capture.recording && !capture.worker) {
                capture.symbols = [];
                capture.symbolRanges = undefined;
            }
            if (!capture.configured) { capture.summary = undefined; }
        }
        this.sendSnapshot();
    }

    private hasPCSamplingConfig(args: any): boolean {
        return !!(args?.swoConfig?.enabled && args?.swoConfig?.profile);
    }

    private stopCapture(capture: TraceCapture, keepSummary: boolean): void {
        if (!capture.recording && !capture.worker) { return; }
        if (capture.stopping) { return; }
        capture.recording = false;
        capture.stopping = !!capture.worker;
        const ring = capture.ring;
        if (ring) {
            // Let the worker drain the fixed ring before asking for its final report.
            const stopWorker = capture.worker;
            if (stopWorker) {
                const stopPromise = this.requestWorkerSnapshot(capture, true).then((snapshot) => {
                    capture.latest = snapshot;
                    if (keepSummary) { capture.summary = this.createSummary(capture, snapshot); }
                    return snapshot;
                }).finally(() => {
                    stopWorker.postMessage({ type: 'stop' });
                    void stopWorker.terminate();
                    capture.worker = undefined;
                    capture.ring = undefined;
                    capture.stopping = false;
                    capture.stopPromise = undefined;
                    if (capture.terminated) {
                        capture.symbols = [];
                        capture.symbolRanges = undefined;
                    }
                    this.sendSnapshot();
                });
                capture.stopPromise = stopPromise;
                void stopPromise.catch(() => undefined);
            } else {
                capture.ring = undefined;
                capture.stopping = false;
            }
        }
        this.sendSnapshot();
    }

    private requestWorkerSnapshot(capture: TraceCapture, final = false): Promise<TraceSnapshot> {
        if (!capture.worker) { return Promise.resolve(capture.latest); }
        const requestId = ++capture.exportRequestId;
        return new Promise<TraceSnapshot>((resolve, reject) => {
            if (capture.exportRequest) {
                capture.exportRequest.reject(new Error('A Trace report request is already pending.'));
            }
            capture.exportRequest = { resolve, reject };
            capture.worker.postMessage({ type: final ? 'final' : 'export', requestId });
        });
    }

    private onWorkerMessage(capture: TraceCapture, message: WorkerMessage): void {
        if (message.type === 'error') {
            if (capture.exportRequest) {
                capture.exportRequest.reject(new Error(message.message || 'Trace worker error'));
                capture.exportRequest = undefined;
            }
            return;
        }
        if (!message.snapshot) { return; }
        const snapshot = this.decorateSnapshot(capture, message.snapshot);
        capture.latest = snapshot;
        if ((message.type === 'export' || message.type === 'final') && capture.exportRequest && message.requestId === capture.exportRequestId) {
            capture.exportRequest.resolve(snapshot);
            capture.exportRequest = undefined;
        } else {
            this.sendSnapshot();
        }
    }

    private decorateSnapshot(capture: TraceCapture, snapshot: TraceSnapshot): TraceSnapshot {
        const raw = snapshot as any;
        const functions: TraceFunctionRow[] = (raw.functions || []).map((row: any) => {
            const symbol = capture.symbols[row.symbolIndex];
            return {
                name: symbol?.name || '<unknown>',
                address: symbol?.address ?? 0,
                samples: row.samples
            };
        });
        const addresses: TraceAddressRow[] = (raw.addresses || []).map((row: any) => ({
            address: row.address >>> 0,
            samples: row.samples,
            functionName: capture.symbols[row.symbolIndex]?.name || ''
        }));
        return { ...snapshot, functions, addresses };
    }

    private createSummary(capture: TraceCapture, snapshot: TraceSnapshot): TraceSessionSummary {
        const startedAt = capture.startedAt || Date.now();
        const endedAt = capture.recording ? undefined : Date.now();
        return {
            ...snapshot,
            mode: 'swo-pc-sampling',
            quality: 'sampled',
            startedAt: new Date(startedAt).toISOString(),
            endedAt: endedAt ? new Date(endedAt).toISOString() : undefined,
            durationMs: Math.max(0, (endedAt || Date.now()) - startedAt),
            averagePcSamplesPerSecond: (snapshot.totalPcSamples * 1000) / Math.max(1, (endedAt || Date.now()) - startedAt),
            sleepSamples: capture.sleepSamples + (capture.ring ? Atomics.load(capture.ring, 3) : 0),
            gapCount: capture.gapCount,
            gapReasons: { ...capture.gapReasons },
            elf: capture.args?.executable || capture.session.configuration?.program || '',
            elfSha256: '',
            elfHashStatus: 'unavailable',
            target: capture.args?.device || capture.session.configuration?.device || '',
            probe: capture.args?.servertype || capture.session.configuration?.servertype || 'unknown',
            swoSource: capture.args?.swoConfig?.source || 'unknown',
            coverage: {
                available: false,
                lineCoverage: false,
                instructionCoverage: false,
                reason: 'This capture uses statistical SWO PC samples. Exact line and instruction coverage requires a complete, decoded instruction trace.'
            }
        };
    }

    private toCsv(report: TraceSessionSummary): string {
        const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const shareFor = (samples: number) => report.totalPcSamples
            ? (100 * samples / report.totalPcSamples).toFixed(4)
            : '0';
        const functionRows = report.functions.map((row) => [
            'function', quote(row.name), `0x${row.address.toString(16)}`, row.samples, shareFor(row.samples)
        ].join(','));
        const addressRows = report.addresses.map((row) => [
            'instruction_address', quote(row.functionName || ''), `0x${row.address.toString(16)}`, row.samples, shareFor(row.samples)
        ].join(','));
        const rows = [
            'section,name,address,pc_samples,share',
            `summary,${quote('ELF')},${quote(report.elf)},,`,
            `summary,${quote('ELF SHA-256')},${quote(report.elfSha256)},,`,
            `summary,${quote('ELF hash status')},${quote(report.elfHashStatus)},,`,
            `summary,${quote('target')},${quote(report.target)},,`,
            `summary,${quote('probe')},${quote(report.probe)},,`,
            `summary,${quote('SWO source')},${quote(report.swoSource)},,`,
            `summary,${quote('mode')},${quote(report.mode)},,`,
            `summary,${quote('started at')},${quote(report.startedAt)},,`,
            `summary,${quote('ended at')},${quote(report.endedAt || '')},,`,
            `summary,${quote('duration ms')},${report.durationMs},,`,
            `summary,${quote('average PC samples per second')},${report.averagePcSamplesPerSecond.toFixed(3)},,`,
            `summary,${quote('quality')},${quote(report.quality)},,`,
            ...functionRows,
            ...addressRows,
            `summary,${quote('total PC samples')},,${report.totalPcSamples},`,
            `summary,${quote('mapped PC samples')},,${report.mappedSamples},`,
            `summary,${quote('unmapped PC samples')},,${report.unmappedSamples},`,
            `summary,${quote('dropped PC samples')},,${report.droppedSamples},`,
            `summary,${quote('omitted address samples')},,${report.omittedAddressSamples},`,
            `summary,${quote('sleep samples')},,${report.sleepSamples},`,
            `summary,${quote('gap events')},,${report.gapCount},`,
            ...Object.entries(report.gapReasons).map(([reason, count]) => `gap,${quote(reason)},,${count},`),
            'summary,coverage,,unavailable,"SWO PC sampling cannot establish line or instruction coverage"'
        ];
        return rows.join('\n') + '\n';
    }

    private hashElf(filename: string): Promise<string> {
        if (!filename) { return Promise.resolve(''); }
        const source = `
            const fs = require('fs');
            const crypto = require('crypto');
            const { parentPort, workerData } = require('worker_threads');
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(workerData.filename);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('error', (error) => parentPort.postMessage({ error: error.message }));
            stream.on('end', () => parentPort.postMessage({ hash: hash.digest('hex') }));
        `;
        return new Promise<string>((resolve) => {
            const worker = new Worker(source, { eval: true, workerData: { filename } });
            let settled = false;
            const finish = (value: string) => {
                if (settled) { return; }
                settled = true;
                resolve(value);
                void worker.terminate();
            };
            worker.once('message', (message: { hash?: string; error?: string }) => finish(message.hash || ''));
            worker.once('error', () => finish(''));
            worker.once('exit', () => {
                if (!settled) { finish(''); }
            });
        });
    }

    private async handleMessage(message: TraceViewMessage): Promise<void> {
        if (message?.type === 'ready') {
            this.ready = true;
            this.sendSnapshot();
        } else if (message?.type === 'action') {
            switch (message.action) {
                case 'start':
                    this.startForActiveSession();
                    break;
                case 'stop':
                    this.stopForActiveSession();
                    break;
                case 'export':
                    await this.exportForActiveSession();
                    break;
                case 'clear':
                    this.clearForActiveSession();
                    break;
            }
        }
    }

    private sendSnapshot(): void {
        if (!this.ready || !this.view?.visible) { return; }
        const capture = this.captures.get(this.activeSessionId);
        const summary = capture?.summary;
        const current = capture?.latest;
        const elapsedMs = capture?.startedAt ? Date.now() - capture.startedAt : 0;
        let state = 'unavailable';
        if (!capture) {
            state = 'no-session';
        } else if (capture.recording) {
            state = 'recording';
        } else if (capture.stopping) {
            state = 'stopping';
        } else if (summary) {
            state = 'stopped';
        } else if (capture.sourceReady && capture.configured && capture.symbolsReady) {
            state = 'ready';
        }
        let sleepSamples = summary?.sleepSamples ?? capture?.sleepSamples ?? 0;
        if (capture?.ring && (capture.recording || capture.stopping)) {
            sleepSamples = Atomics.load(capture.ring, 3);
        }
        void this.view.webview.postMessage({
            type: 'state',
            state,
            message: this.stateMessage(capture, state),
            configured: !!capture?.configured,
            sourceReady: !!capture?.sourceReady,
            durationMs: summary?.durationMs ?? elapsedMs,
            averagePcSamplesPerSecond: summary?.averagePcSamplesPerSecond ?? ((current?.totalPcSamples || 0) * 1000 / Math.max(1, elapsedMs)),
            totalPcSamples: current?.totalPcSamples ?? summary?.totalPcSamples ?? 0,
            mappedSamples: current?.mappedSamples ?? summary?.mappedSamples ?? 0,
            unmappedSamples: current?.unmappedSamples ?? summary?.unmappedSamples ?? 0,
            droppedSamples: current?.droppedSamples ?? summary?.droppedSamples ?? 0,
            omittedAddressSamples: current?.omittedAddressSamples ?? summary?.omittedAddressSamples ?? 0,
            sleepSamples,
            gapCount: capture?.gapCount ?? summary?.gapCount ?? 0,
            functions: current?.functions ?? summary?.functions ?? [],
            addresses: current?.addresses ?? summary?.addresses ?? [],
            quality: summary?.quality || (capture?.recording ? 'sampled' : '')
        });
    }

    private stateMessage(capture: TraceCapture | undefined, state: string): string {
        if (state === 'no-session') { return '启动 Cortex-Debug 后，在这里开始 Trace 记录。'; }
        if (state === 'recording') { return '正在从现有 SWO 数据流被动收集 PC 样本。'; }
        if (state === 'stopping') { return '正在后台整理本次结果，Live Watch 采样仍独立运行。'; }
        if (state === 'stopped') { return '已停止。报告为 PC 采样热点；未采样到不代表代码未执行。'; }
        if (!capture?.configured) { return '启动配置尚未启用 swoConfig.profile；请配置 SWO PC 采样并重启调试。'; }
        if (!capture.sourceReady) { return '等待 SWO 数据源。请检查探针、SWO 接线、时钟和数据 source。'; }
        if (!capture.symbolsReady) { return '正在等待 ELF 函数符号加载完成。'; }
        return 'SWO PC 采样已就绪。';
    }

    private getWorkerSource(): string {
        return `
            const { parentPort, workerData } = require('worker_threads');
            const ring = new Int32Array(workerData.shared);
            const capacity = workerData.capacity;
            const controlWords = workerData.controlWords;
            const symbolRanges = new Uint32Array(workerData.symbolRanges);
            const symbolCount = workerData.symbolCount;
            const functionCounts = new Map();
            const addressCounts = new Map();
            let total = 0, mapped = 0, unmapped = 0, dropped = 0, omittedAddressSamples = 0;
            const MAX_ADDRESSES = 20000;

            function findSymbol(pc) {
                let lo = 0, hi = symbolCount - 1;
                while (lo <= hi) {
                    const mid = (lo + hi) >>> 1;
                    const address = symbolRanges[mid * 2] >>> 0;
                    const length = symbolRanges[mid * 2 + 1] >>> 0;
                    if (pc < address) hi = mid - 1;
                    else if (pc >= address + length) lo = mid + 1;
                    else return mid;
                }
                return -1;
            }

            function drain() {
                let read = Atomics.load(ring, 1), write = Atomics.load(ring, 0), processed = 0;
                while (read !== write && processed < 4096) {
                    const raw = ring[controlWords + read] >>> 0;
                    const pc = raw & 0xFFFFFFFE;
                    const symbolIndex = findSymbol(pc);
                    total++;
                    if (symbolIndex >= 0) {
                        mapped++;
                        functionCounts.set(symbolIndex, (functionCounts.get(symbolIndex) || 0) + 1);
                    } else { unmapped++; }
                    if (addressCounts.has(pc)) addressCounts.set(pc, addressCounts.get(pc) + 1);
                    else if (addressCounts.size < MAX_ADDRESSES) addressCounts.set(pc, 1);
                    else omittedAddressSamples++;
                    read = (read + 1) % capacity;
                    processed++;
                }
                Atomics.store(ring, 1, read);
                dropped += Atomics.exchange(ring, 2, 0);
            }

            function snapshot(full) {
                const limit = full ? Number.MAX_SAFE_INTEGER : 30;
                const functions = Array.from(functionCounts, ([symbolIndex, samples]) => ({
                    symbolIndex, samples
                })).sort((a, b) => b.samples - a.samples).slice(0, limit);
                const addresses = Array.from(addressCounts, ([address, samples]) => {
                    return { address, samples, symbolIndex: findSymbol(address) };
                }).sort((a, b) => b.samples - a.samples).slice(0, limit);
                return { totalPcSamples: total, mappedSamples: mapped, unmappedSamples: unmapped,
                    droppedSamples: dropped, omittedAddressSamples, functions, addresses };
            }

            const ringTimer = setInterval(drain, ${TRACE_RING_TICK_MS});
            const statusTimer = setInterval(() => {
                drain();
                parentPort.postMessage({ type: 'snapshot', snapshot: snapshot(false) });
            }, ${TRACE_STATUS_TICK_MS});
            parentPort.on('message', (message) => {
                if (message.type === 'export') {
                    drain();
                    parentPort.postMessage({ type: 'export', requestId: message.requestId, snapshot: snapshot(true) });
                } else if (message.type === 'final') {
                    while (Atomics.load(ring, 0) !== Atomics.load(ring, 1)) drain();
                    parentPort.postMessage({ type: 'final', requestId: message.requestId, snapshot: snapshot(true) });
                } else if (message.type === 'stop') {
                    clearInterval(ringTimer);
                    clearInterval(statusTimer);
                    drain();
                    parentPort.close();
                }
            });
        `;
    }

    public async reveal(): Promise<void> {
        await vscode.commands.executeCommand('cortex-debug.trace.focus');
    }

    public dispose(): void {
        for (const capture of this.captures.values()) {
            this.stopCapture(capture, false);
        }
        this.captures.clear();
    }
}
