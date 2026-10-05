import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as vscode from 'vscode';
import { isMujocoLaunch } from './mujoco-config';
import { LiveWatchTreeProvider } from './views/live-watch';
import { LiveTableViewProvider } from './views/live-table';

/** A private socket serviced on GDB's main event loop, including while the inferior runs. */
export class NativeLiveConnection implements vscode.Disposable {
    private socket: net.Socket | undefined;
    private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
    private buffer = '';
    private queue: Promise<unknown> = Promise.resolve();
    private disposed = false;

    constructor(private readonly pathname: string) { }

    request(command: string, args: any = {}): Promise<unknown> {
        const result = this.queue.then(async () => {
            if (this.disposed) { throw new Error('Live Watch 会话已结束'); }
            await this.connect();
            return new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending = undefined;
                    this.socket?.destroy();
                    this.socket = undefined;
                    reject(new Error('MuJoCo Live Watch 请求超时'));
                }, 10000);
                this.pending = { resolve, reject, timer };
                this.socket.write(JSON.stringify({ command, args }) + '\n');
            });
        });
        this.queue = result.catch(() => {});
        return result;
    }

    private async connect(): Promise<void> {
        if (this.socket) { return; }
        const deadline = Date.now() + 8000;
        while (!this.disposed) {
            const socket = net.createConnection(this.pathname);
            const connected = await new Promise<boolean>((resolve) => {
                socket.once('connect', () => resolve(true));
                socket.once('error', () => resolve(false));
            });
            if (connected) {
                this.socket = socket;
                this.buffer = '';
                socket.on('data', (data: Buffer) => this.receive(data));
                socket.on('error', (error) => {
                    if (this.socket === socket) { this.fail(error); }
                });
                socket.on('close', () => {
                    if (this.socket === socket) { this.fail(new Error('MuJoCo Live Watch GDB 连接已关闭')); }
                });
                return;
            }
            socket.destroy();
            if (Date.now() >= deadline) { throw new Error('MuJoCo Live Watch 未连接：请确认本机 GDB 支持 Python，并重启调试'); }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Live Watch 会话已结束');
    }

    private receive(data: Buffer): void {
        this.buffer += data.toString('utf8');
        const end = this.buffer.indexOf('\n');
        if (end < 0) { return; }
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const pending = this.pending;
        this.pending = undefined;
        if (!pending) { return; }
        clearTimeout(pending.timer);
        try {
            const result = JSON.parse(line);
            if (result.error) {
                pending.reject(new Error(result.error));
            } else {
                pending.resolve(result.body);
            }
        } catch (error) { pending.reject(error as Error); }
    }

    private fail(error: Error): void {
        this.socket = undefined;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(error);
            this.pending = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        const socket = this.socket;
        this.fail(new Error('Live Watch 会话已结束'));
        socket?.destroy();
    }
}

export class NativeLiveWatchController implements vscode.Disposable {
    private readonly sessions = new Map<string, { session: vscode.DebugSession; connection: NativeLiveConnection; directory: string }>();
    private readonly directories = new Set<string>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext,
        private readonly provider: LiveWatchTreeProvider, private readonly view: LiveTableViewProvider) {
        this.subscriptions.push(
            vscode.debug.registerDebugConfigurationProvider('cppdbg', {
                resolveDebugConfigurationWithSubstitutedVariables: (_folder, config) => this.prepare(config)
            }),
            vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
                createDebugAdapterTracker: (session) => ({
                    onDidSendMessage: (message) => {
                        const live = this.sessions.get(session.id)?.session;
                        if (!live || message.type !== 'event') { return; }
                        if (message.event === 'stopped') { this.provider.debugStopped(live); }
                        if (message.event === 'continued') { this.provider.debugContinued(live); }
                    }
                })
            }),
            vscode.debug.onDidStartDebugSession((session) => this.started(session)),
            vscode.debug.onDidTerminateDebugSession((session) => this.terminated(session))
        );
    }

    private prepare(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
        if (process.platform !== 'linux' || !isMujocoLaunch(config) || config.liveWatch?.enabled === false) { return config; }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-live-'));
        const socket = path.join(directory, 'gdb.sock');
        const helper = path.join(this.context.extensionPath, 'support', 'native-live-watch.py');
        this.directories.add(directory);
        const python = `python rm_live_socket = ${JSON.stringify(socket)}; exec(compile(open(${JSON.stringify(helper)}).read(), `
            + `${JSON.stringify(helper)}, "exec"))`;
        return { ...config, rmLiveWatchSocket: socket,
            liveWatch: { enabled: true, samplesPerSecond: 4, ...config.liveWatch },
            setupCommands: [...(config.setupCommands || []), { text: `-interpreter-exec console ${JSON.stringify(python)}` }] };
    }

    getSession(session: vscode.DebugSession): vscode.DebugSession | undefined {
        return this.sessions.get(session?.id)?.session;
    }

    private started(original: vscode.DebugSession): void {
        const pathname = original.configuration.rmLiveWatchSocket;
        if (original.type !== 'cppdbg' || typeof pathname !== 'string' || !this.directories.has(path.dirname(pathname))) { return; }
        const connection = new NativeLiveConnection(pathname);
        // VS Code freezes its public DebugSession object; wrap it without proxying frozen properties.
        const session = Object.create(original, {
            customRequest: { value: (command: string, args: any) =>
                command.startsWith('live') || command === 'load-function-symbols' || command === 'list-file-statics'
                    ? connection.request(command, args)
                    : original.customRequest(command, args) }
        }) as vscode.DebugSession;
        this.sessions.set(original.id, { session, connection, directory: path.dirname(pathname) });
        void vscode.commands.executeCommand('setContext', 'rm-debug.nativeLiveWatchActive', true);
        this.provider.debugSessionStarted(session);
        this.provider.debugContinued(session);
        this.provider.addWatchExpr('arm_application', session);
        this.provider.addWatchExpr('arm_sim_state', session);
        void this.view.reveal();
    }

    private terminated(original: vscode.DebugSession): void {
        const live = this.sessions.get(original.id);
        if (!live) { return; }
        this.sessions.delete(original.id);
        this.provider.debugSessionTerminated(live.session);
        live.connection.dispose();
        this.directories.delete(live.directory);
        fs.rmSync(live.directory, { recursive: true, force: true });
        void vscode.commands.executeCommand('setContext', 'rm-debug.nativeLiveWatchActive', this.sessions.size > 0);
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        for (const live of this.sessions.values()) {
            live.connection.dispose();
        }
        this.sessions.clear();
        for (const directory of this.directories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        this.directories.clear();
    }
}
