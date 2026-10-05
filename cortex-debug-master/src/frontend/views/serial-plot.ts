import * as vscode from 'vscode';
import type { SerialPort } from 'serialport';

import { LivePlotPanel } from './live-plot';

/** Receives named MCU telemetry without coupling acquisition to Live Watch. */
export class SerialPlot implements vscode.Disposable {
    private readonly panel: LivePlotPanel;
    private readonly port: SerialPort;
    private readonly channels = new Map<string, string>();
    private readonly selected = new Set<string>();
    private readonly pendingAdds = new Set<string>();
    private readonly recentTicks: number[] = [];
    private buffer = '';
    private baseWallMs: number | undefined;
    private lastTickMs: number | undefined;
    private lastWallMs = 0;
    private byteCount = 0;
    private frameCount = 0;
    private invalidLines = 0;
    private lastRawLine = '';
    private lastInfoAt = 0;
    private pickerShown = false;
    private disposed = false;

    constructor(
        context: vscode.ExtensionContext, private readonly portPath: string,
        onClosed: () => void,
        private readonly onSample?: (values: Record<string, number>, timestampMs: number, actualHz: number | undefined) => void
    ) {
        // Keep serialport's native binding loading local to this optional feature.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SerialPort: Port } = require('serialport') as typeof import('serialport');
        this.port = new Port({ path: portPath, baudRate: 115200, autoOpen: false });
        this.panel = new LivePlotPanel(context, undefined, () => {
            this.closePort();
            onClosed();
        }, 'serial', () => { void this.pickChannels(); });
        this.panel.setSerialInfo(`${portPath}：正在打开，115200 8N1`);
        this.panel.reveal();

        this.port.on('data', (chunk: Buffer) => this.onData(chunk));
        this.port.on('error', (error: Error) => {
            if (!this.disposed) {
                this.panel.setSerialStatus('terminated');
                this.panel.setSerialInfo(`${portPath}：串口错误 ${error.message}`);
                void vscode.window.showErrorMessage(`rm_debug：串口 ${portPath} 出错：${error.message}`);
            }
        });
        this.port.on('close', () => {
            if (!this.disposed) {
                this.panel.setSerialStatus('terminated');
                this.panel.setSerialInfo(`${portPath}：已断开`);
            }
        });
        this.port.open((error) => {
            if (this.disposed) { return; }
            if (error) {
                this.panel.setSerialStatus('terminated');
                this.panel.setSerialInfo(`${portPath}：打开失败 ${error.message}`);
                void vscode.window.showErrorMessage(`rm_debug：无法打开 ${portPath}：${error.message}`);
            } else {
                this.showInfo(true);
            }
        });
    }

    public reveal(): void { this.panel.reveal(); }

    public get isOpen(): boolean { return this.port.isOpen; }

    public getAvailableChannels(): string[] { return [...this.channels.keys()].sort(); }

    /** Adds a Live Watch expression when firmware is already transmitting it. */
    public addChannel(id: string): boolean {
        if (!this.channels.has(id)) {
            this.pendingAdds.add(id);
            setTimeout(() => {
                if (!this.pendingAdds.delete(id) || this.disposed) { return; }
                const available = [...this.channels.keys()].join('、');
                void vscode.window.showWarningMessage(this.channels.size
                    ? `rm_debug：串口固件尚未上报 ${id}。当前可选：${available}`
                    : 'rm_debug：还没有收到串口变量。请检查图窗下方的接收字节数。');
            }, 3000);
            this.reveal();
            return true;
        }
        this.selected.add(id);
        this.syncSeries();
        this.reveal();
        return true;
    }

    private async pickChannels(): Promise<void> {
        if (!this.channels.size) {
            void vscode.window.showInformationMessage('rm_debug：还没有收到固件上报的变量，暂时无可选曲线。');
            return;
        }
        const choices = [...this.channels].map(([id, label]) => ({ label, id, picked: this.selected.has(id) }));
        const picked = await vscode.window.showQuickPick(choices, {
            title: 'rm_debug：选择串口波形变量', canPickMany: true,
            placeHolder: '只能选择固件已上报的变量；可多选'
        });
        if (!picked) { return; }
        this.selected.clear();
        for (const item of picked) {
            this.selected.add(item.id);
        }
        this.syncSeries();
    }

    private syncSeries(): void {
        this.panel.setSerialSeries([...this.selected].map((id) => ({ id, label: this.channels.get(id) || id })));
    }

    private onData(chunk: Buffer): void {
        if (this.disposed) { return; }
        this.byteCount += chunk.length;
        this.buffer += chunk.toString('ascii');
        if (this.buffer.length > 4096) {
            this.invalidLines++;
            this.lastRawLine = '超过 4096 字节仍未出现换行';
            this.buffer = '';
        }
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            this.onLine(line);
            newline = this.buffer.indexOf('\n');
        }
        this.showInfo();
    }

    private onLine(line: string): void {
        const fields = line.split(',');
        let values: Record<string, number> = {};
        let tickMs: number | undefined;
        if (fields[0] === 'RM2' && fields.length >= 3 && /^\d{1,10}$/.test(fields[1])) {
            tickMs = Number(fields[1]);
            for (const field of fields.slice(2)) {
                const match = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*)=(-?(?:\d+\.?\d*|\.\d+))$/.exec(field);
                if (!match) {
                    tickMs = undefined;
                    break;
                }
                const value = Number(match[2]);
                if (!Number.isFinite(value)) {
                    tickMs = undefined;
                    break;
                }
                values[match[1]] = value;
            }
        } else {
            const legacy = /^RM,(\d{1,10}),(\d{1,9}),([01])$/.exec(line);
            if (legacy) {
                tickMs = Number(legacy[1]);
                values = {
                    'g_led_debug.blink_frequency_hz': Number(legacy[2]) / 1000,
                    'g_led_debug.led_on': Number(legacy[3])
                };
            }
        }
        if (tickMs === undefined || !Object.keys(values).length) {
            this.invalidLines++;
            this.lastRawLine = line.replace(/[^\x20-\x7e]/g, '.').slice(0, 80);
            return;
        }
        this.frameCount++;
        for (const id of Object.keys(values)) {
            this.channels.set(id, id);
        }
        let added = false;
        for (const id of this.pendingAdds) {
            if (this.channels.has(id)) {
                this.pendingAdds.delete(id);
                this.selected.add(id);
                added = true;
            }
        }
        if (added) {
            this.pickerShown = true;
            this.syncSeries();
        }
        if (this.lastTickMs !== undefined && tickMs <= this.lastTickMs) {
            this.baseWallMs = undefined;
            this.recentTicks.length = 0;
        }
        if (this.baseWallMs === undefined) { this.baseWallMs = Date.now() - tickMs; }
        const timestampMs = Math.max(this.baseWallMs + tickMs, this.lastWallMs + 1);
        this.lastTickMs = tickMs;
        this.lastWallMs = timestampMs;
        this.recentTicks.push(tickMs);
        while (this.recentTicks.length > 2 && this.recentTicks[0] < tickMs - 1000) {
            this.recentTicks.shift();
        }
        const durationMs = this.recentTicks.length > 1 ? tickMs - this.recentTicks[0] : 0;
        const actualHz = durationMs > 0 ? (this.recentTicks.length - 1) * 1000 / durationMs : undefined;
        this.onSample?.(values, timestampMs, actualHz);
        this.panel.addSerialSample(timestampMs, actualHz, values);
        if (this.frameCount === 1) { this.panel.setSerialStatus('running'); }
        if (!this.pickerShown) {
            this.pickerShown = true;
            void this.pickChannels();
        }
    }

    private showInfo(force = false): void {
        const now = Date.now();
        if (!force && now - this.lastInfoAt < 500) { return; }
        this.lastInfoAt = now;
        const raw = this.invalidLines ? ` · 最近原始行：${this.lastRawLine}` : '';
        this.panel.setSerialInfo(`${this.portPath} 已打开 · 收到 ${this.byteCount} 字节 · 有效帧 ${this.frameCount} · 无效行 ${this.invalidLines}${raw}`);
    }

    private closePort(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.port.isOpen) { this.port.close(); }
    }

    public dispose(): void { this.panel.dispose(); }
}
