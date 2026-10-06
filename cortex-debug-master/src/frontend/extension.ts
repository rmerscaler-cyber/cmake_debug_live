import { toolName } from './rm-tools';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { CortexDebugChannel } from '../dbgmsgs';
import { LiveWatchTreeProvider, LiveVariableNode, PinnedLocalInfo } from './views/live-watch';
import { LiveTableViewProvider } from './views/live-table';
import { NativeLiveWatchController } from './native-live-watch';
import { LivePlotPanel } from './views/live-plot';
import { SerialPlot } from './views/serial-plot';
import { TraceViewProvider } from './trace/trace-view';

import { RTTCore, SWOCore } from './swo/core';
import {
    ConfigurationArguments, RTTCommonDecoderOpts, RTTConsoleDecoderOpts,
    CortexDebugKeys, ChainedEvents, ADAPTER_DEBUG_MODE, ChainedConfig
} from '../common';
import { MemoryContentProvider } from './memory_content_provider';

import { CortexDebugConfigurationProvider } from './configprovider';
import { JLinkSocketRTTSource, SocketRTTSource, SocketSWOSource, PeMicroSocketSource } from './swo/sources/socket';
import { FifoSWOSource } from './swo/sources/fifo';
import { FileSWOSource } from './swo/sources/file';
import { SerialSWOSource } from './swo/sources/serial';
import { UsbSWOSource } from './swo/sources/usb';
import { SymbolInformation, SymbolScope } from '../symbols';
import { RTTTerminal } from './rtt_terminal';
import { GDBServerConsole } from './server_console';
import { CDebugSession, CDebugChainedSessionItem } from './cortex_debug_session';
import { ServerConsoleLog } from '../backend/server';
import { RmWorkflow } from './rm-workflow';
import { RmSearch } from './rm-search';

interface SVDInfo {
    expression: RegExp;
    path: string;
}
class ServerStartedPromise {
    constructor(
        public readonly name: string,
        public readonly promise: Promise<vscode.DebugSessionCustomEvent>,
        public readonly resolve: any,
        public readonly reject: any) {
    }
}

export class CortexDebugExtension {
    private rttTerminals: RTTTerminal[] = [];

    private gdbServerConsole: GDBServerConsole | null = null;

    private memoryProvider: MemoryContentProvider;
    private liveWatchProvider: LiveWatchTreeProvider;
    private liveWatchView: LiveTableViewProvider;
    private nativeLiveWatch: NativeLiveWatchController;
    private traceView: TraceViewProvider;
    private livePlotPanel: LivePlotPanel | undefined;
    private serialPlot: SerialPlot | undefined;

    private SVDDirectory: SVDInfo[] = [];
    private functionSymbols: SymbolInformation[] | null = null;
    private serverStartedEvent: ServerStartedPromise | undefined;

    constructor(private context: vscode.ExtensionContext) {
        new RmWorkflow(context);
        new RmSearch(context);
        const config = vscode.workspace.getConfiguration('cortex-debug');
        this.startServerConsole(context, config.get(CortexDebugKeys.SERVER_LOG_FILE_NAME, '')); // Make this the first thing we do to be ready for the session
        this.memoryProvider = new MemoryContentProvider();

        this.liveWatchProvider = new LiveWatchTreeProvider(this.context);
        this.liveWatchView = new LiveTableViewProvider(this.context, this.liveWatchProvider);
        this.nativeLiveWatch = new NativeLiveWatchController(this.context, this.liveWatchProvider, this.liveWatchView);
        context.subscriptions.push(this.nativeLiveWatch);
        this.traceView = new TraceViewProvider(this.context);

        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`,
            config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true));

        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider('examinememory', this.memoryProvider),

            vscode.commands.registerCommand('cortex-debug.varHexModeTurnOn', this.variablesNaturalMode.bind(this, false)),
            vscode.commands.registerCommand('cortex-debug.varHexModeTurnOff', this.variablesNaturalMode.bind(this, true)),
            vscode.commands.registerCommand('cortex-debug.toggleVariableHexFormat', this.toggleVariablesHexMode.bind(this)),

            vscode.commands.registerCommand('cortex-debug.examineMemory', this.examineMemory.bind(this)),
            vscode.commands.registerCommand('cortex-debug.examineMemoryLegacy', this.examineMemoryLegacy.bind(this)),

            vscode.commands.registerCommand('cortex-debug.resetDevice', this.resetDevice.bind(this)),
            vscode.commands.registerCommand('cortex-debug.pvtEnableDebug', this.pvtCycleDebugMode.bind(this)),

            vscode.commands.registerCommand('cortex-debug.liveWatch.addExpr', this.addLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.removeExpr', this.removeLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.editExpr', this.editLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.addToLiveWatch', this.addToLiveWatch.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.addVariableAll', (arg: any) => this.addToLiveWatch(arg, true)),
            vscode.commands.registerCommand('rm-debug.liveWatch.pinLocal', this.pinLocalToLiveWatch.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.addSerialChannel', this.addSerialChannelToLiveWatch.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.moveUp', this.moveUpLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.moveDown', this.moveDownLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.addReceiveStruct', this.addReceiveStruct.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.addFileStatic', this.addFileStatic.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.setRate', this.setLiveWatchRate.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.setNumberFormat', this.setLiveWatchNumberFormat.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.toggleMonitorAll', this.toggleMonitorAll.bind(this)),
            vscode.commands.registerCommand('rm-debug.liveWatch.loadMore', (node: LiveVariableNode) => this.liveWatchProvider.loadMore(node)),
            vscode.commands.registerCommand('rm-debug.liveWatch.showValues', () => this.liveWatchView.reveal()),
            vscode.commands.registerCommand('rm-debug.liveWatch.gotoFunctionTarget', this.gotoFunctionTarget.bind(this)),
            vscode.commands.registerCommand('rm-debug.livePlot.show', this.showLivePlot.bind(this)),
            vscode.commands.registerCommand('rm-debug.livePlot.add', this.addToLivePlot.bind(this)),
            vscode.commands.registerCommand('rm-debug.plot.show', this.showPlotPicker.bind(this)),
            vscode.commands.registerCommand('rm-debug.serialPlot.show', this.showSerialPlot.bind(this)),
            vscode.commands.registerCommand('rm-debug.serialPlot.add', this.addToSerialPlot.bind(this)),
            vscode.commands.registerCommand('rm-debug.trace.show', () => this.traceView.reveal()),
            vscode.commands.registerCommand('rm-debug.trace.start', () => this.traceView.startForActiveSession()),
            vscode.commands.registerCommand('rm-debug.trace.stop', () => this.traceView.stopForActiveSession()),
            vscode.commands.registerCommand('rm-debug.trace.export', () => this.traceView.exportForActiveSession()),
            vscode.commands.registerCommand('rm-debug.trace.clear', () => this.traceView.clearForActiveSession()),

            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent(this.receivedCustomEvent.bind(this)),
            vscode.debug.onDidStartDebugSession(this.debugSessionStarted.bind(this)),
            vscode.debug.onDidChangeActiveDebugSession((session) => this.traceView.activateSession(session)),
            vscode.debug.onDidTerminateDebugSession(this.debugSessionTerminated.bind(this)),
            vscode.window.onDidChangeActiveTextEditor(this.activeEditorChanged.bind(this)),
            vscode.window.onDidCloseTerminal(this.terminalClosed.bind(this)),
            vscode.workspace.onDidCloseTextDocument(this.textDocsClosed.bind(this)),
            vscode.window.onDidChangeTextEditorSelection((e: vscode.TextEditorSelectionChangeEvent) => {
                if (e && e.textEditor.document.fileName.endsWith('.cdmem')) { this.memoryProvider.handleSelection(e); }
            }),

            vscode.debug.registerDebugConfigurationProvider('cortex-debug', new CortexDebugConfigurationProvider(context)),

            this.liveWatchView,
            vscode.window.registerWebviewViewProvider('cortex-debug.liveWatch', this.liveWatchView,
                { webviewOptions: { retainContextWhenHidden: true } }),
            this.traceView,
            vscode.window.registerWebviewViewProvider('cortex-debug.trace', this.traceView,
                { webviewOptions: { retainContextWhenHidden: true } })
        );
    }

    private textDocsClosed(e: vscode.TextDocument) {
        if (e.fileName.endsWith('.cdmem')) {
            this.memoryProvider.Unregister(e);
        }
    }

    public static getActiveCDSession() {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === 'cortex-debug') {
            return session;
        }
        return null;
    }

    private resetDevice() {
        let session = CortexDebugExtension.getActiveCDSession();
        if (session) {
            let mySession = CDebugSession.FindSession(session);
            const parentConfig = mySession?.config?.pvtParent;
            while (mySession && parentConfig) {
                // We have a parent. See if our life-cycle is managed by our parent, if so
                // send a reset to the parent instead
                const chConfig = mySession.config?.pvtMyConfigFromParent as ChainedConfig;
                if (chConfig?.lifecycleManagedByParent && parentConfig.__sessionId) {
                    // __sessionId is not documented but has existed forever and used by VSCode itself
                    mySession = CDebugSession.FindSessionById(parentConfig.__sessionId);
                    if (!mySession) {
                        break;
                    }
                    session = mySession.session || session;
                } else {
                    break;
                }
            }
            session.customRequest('reset-device', 'reset');
        }
    }

    private startServerConsole(context: vscode.ExtensionContext, logFName: string = ''): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const rptMsg = 'Please report this problem.';
            this.gdbServerConsole = new GDBServerConsole(context, logFName);
            this.gdbServerConsole.startServer().then(() => {
                resolve(); // All worked out
            }).catch((e) => {
                this.gdbServerConsole?.dispose();
                this.gdbServerConsole = null;
                vscode.window.showErrorMessage(`Could not create gdb-server-console. Will use old style console. Please report this problem. ${e.toString()}`);
            });
        });
    }

    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const isHex = config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true) ? false : true;
            let foundStopped = false;
            for (const s of CDebugSession.CurrentSessions) {
                try {
                    // Session may not have actually started according to VSCode but we know of it
                    if (this.isDebugging(s.session)) {
                        s.session.customRequest('set-var-format', { hex: isHex }).then(() => {
                            if (s.status === 'stopped') {
                                this.liveWatchProvider?.refresh(s.session);
                            }
                        });
                        if (s.status === 'stopped') {
                            foundStopped = true;
                        }
                    }
                } catch (e) {
                    console.error('set-var-format', e);
                }
            }
            if (!foundStopped) {
                const fmt = isHex ? 'hex' : 'dec';
                const msg = `Cortex-Debug: Variables window format "${fmt}" will take effect next time the session pauses`;
                vscode.window.showInformationMessage(msg);
            }
        }
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.SERVER_LOG_FILE_NAME}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const fName = config.get(CortexDebugKeys.SERVER_LOG_FILE_NAME, '');
            if (this.gdbServerConsole) {
                this.gdbServerConsole.createLogFile(fName);
            }
        }
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.DEV_DEBUG_MODE}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const dbgMode = config.get(CortexDebugKeys.DEV_DEBUG_MODE, ADAPTER_DEBUG_MODE.NONE);
            for (const s of CDebugSession.CurrentSessions) {
                try {
                    s.session.customRequest('set-debug-mode', { mode: dbgMode });
                } catch (e) {
                    console.error('set-debug-mode', e);
                }
            }
        }
    }

    private getSVDFile(device: string): string | null {
        const entry = this.SVDDirectory.find((de) => de.expression.test(device));
        return entry ? entry.path : null;
    }

    public registerSVDFile(expression: RegExp | string, path: string): void {
        if (typeof expression === 'string') {
            expression = new RegExp(`^${expression}$`, '');
        }

        this.SVDDirectory.push({ expression: expression, path: path });
    }

    private activeEditorChanged(editor: vscode.TextEditor | undefined) {
        if (editor && editor.document.uri.scheme === 'file') {
            const session = CortexDebugExtension.getActiveCDSession();
            if (session) {
                // session.customRequest('set-active-editor', { path: editor.document.uri.fsPath });
            }
        }
    }

    private examineMemory() {
        const cmd = 'mcu-debug.memory-view.addMemoryView';
        vscode.commands.executeCommand(cmd).then(() => { }, (e) => {
            const installExt = 'Install MemoryView Extension';
            vscode.window.showErrorMessage(
                `Unable to execute ${cmd}. Perhaps the MemoryView extension is not installed. `
                + 'Please install extension and try again. A restart may be needed', {},
                {
                    title: installExt
                },
                {
                    title: 'Cancel'
                }
            ).then((v) => {
                if (v && (v.title === installExt)) {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'mcu-debug.memory-view');
                }
            });
        });
    }

    private examineMemoryLegacy() {
        function validateValue(address: string) {
            if (/^0x[0-9a-f]{1,8}$/i.test(address)) {
                return address;
            } else if (/^[0-9]+$/i.test(address)) {
                return address;
            } else {
                return null;
            }
        }

        function validateAddress(address: string) {
            if (address === '') {
                return null;
            }
            return address;
        }

        const session = CortexDebugExtension.getActiveCDSession();
        if (!session) {
            vscode.window.showErrorMessage('No cortex-debug session available');
            return;
        }

        vscode.window.showInputBox({
            placeHolder: 'Enter a valid C/gdb expression. Use 0x prefix for hexadecimal numbers',
            ignoreFocusOut: true,
            prompt: 'Memory Address'
        }).then(
            (address) => {
                if (!address) { return; }
                address = address.trim();
                if (!validateAddress(address)) {
                    vscode.window.showErrorMessage('Invalid memory address entered');
                    return;
                }

                vscode.window.showInputBox({
                    placeHolder: 'Enter a constant value. Prefix with 0x for hexadecimal format.',
                    ignoreFocusOut: true,
                    prompt: 'Length'
                }).then(
                    (length) => {
                        if (!length) { return; }
                        length = length.trim();
                        if (!validateValue(length)) {
                            vscode.window.showErrorMessage('Invalid length entered');
                            return;
                        }

                        const timestamp = new Date().getTime();
                        const addrEnc = encodeURIComponent(`${address}`);
                        const uri = vscode.Uri.parse(
                            `examinememory:///Memory%20[${addrEnc},${length}].cdmem`
                            + `?address=${addrEnc}&length=${length}&timestamp=${timestamp}`
                        );
                        this.memoryProvider.PreRegister(uri);
                        vscode.workspace.openTextDocument(uri)
                            .then((doc) => {
                                this.memoryProvider.Register(doc);
                                vscode.window.showTextDocument(doc, { viewColumn: 2, preview: false });
                            }, (error) => {
                                vscode.window.showErrorMessage(`Failed to examine memory: ${error}`);
                            });
                    },
                    (error) => {

                    }
                );
            },
            (error) => {

            }
        );
    }

    private getConfigSource(config: vscode.WorkspaceConfiguration, section: string): [vscode.ConfigurationTarget, boolean] {
        const configurationTargetMapping: [string, vscode.ConfigurationTarget][] = [
            ['workspaceFolder', vscode.ConfigurationTarget.WorkspaceFolder],
            ['workspace', vscode.ConfigurationTarget.Workspace],
            ['global', vscode.ConfigurationTarget.Global],
            // Modify user settings if setting isn't configured yet
            ['default', vscode.ConfigurationTarget.Global],
        ];
        const info = config.inspect(section);
        for (const inspectKeySuffix of ['LanguageValue', 'Value']) {
            for (const mapping of configurationTargetMapping) {
                const [inspectKeyPrefix, mappingTarget] = mapping;
                const inspectKey = inspectKeyPrefix + inspectKeySuffix;
                if (info && (info as any)[inspectKey] !== undefined)
                    return [mappingTarget, inspectKeySuffix == 'LanguageValue'];
            }
        }
        // Shouldn't get here unless new configuration targets get added to the
        // VSCode API, only those sources have values for this setting, and this
        // setting doesn't have a default value. Still, do something rational
        // just in case.
        return [vscode.ConfigurationTarget.Global, false];
    }

    // Settings changes
    private variablesNaturalMode(newVal: boolean, cxt?: any) {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration('cortex-debug');

        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, CortexDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(CortexDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    private toggleVariablesHexMode() {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const curVal = config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true);
        const newVal = !curVal;
        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, CortexDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(CortexDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    private pvtCycleDebugMode() {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const curVal: ADAPTER_DEBUG_MODE = config.get(CortexDebugKeys.DEV_DEBUG_MODE, ADAPTER_DEBUG_MODE.NONE);
        const validVals = Object.values(ADAPTER_DEBUG_MODE);
        let ix = validVals.indexOf(curVal);
        ix = ix < 0 ? ix = 0 : ((ix + 1) % validVals.length);
        config.set(CortexDebugKeys.DEV_DEBUG_MODE, validVals[ix]);
    }

    // Debug Events
    private debugSessionStarted(session: vscode.DebugSession) {
        if (session.type !== 'cortex-debug') { return; }

        const newSession = CDebugSession.NewSessionStarted(session);
        this.traceView.activateSession(session);

        this.functionSymbols = null;
        session.customRequest('get-arguments').then((args) => {
            newSession.config = args;
            this.traceView.setDebugSession(session, args);
            let svdfile = args.svdFile;
            if (!svdfile) {
                svdfile = this.getSVDFile(args.device);
            }

            if (newSession.swoSource) {
                this.initializeSWO(session, args);
            }
            if (Object.keys(newSession.rttPortMap).length > 0) {
                this.initializeRTT(session, args);
            }
            this.cleanupRTTTerminals();
        }, (error) => {
            vscode.window.showErrorMessage(
                `Internal Error: Could not get startup arguments. Many debug functions can fail. Please report this problem. Error: ${error}`);
        });
    }

    private debugSessionTerminated(session: vscode.DebugSession) {
        if (session.type !== 'cortex-debug') { return; }
        const mySession = CDebugSession.FindSession(session);
        try {
            this.traceView.sessionTerminated(session);
            this.liveWatchProvider?.debugSessionTerminated(session);
            if (mySession?.swo) {
                mySession.swo.debugSessionTerminated();
            }
            if (mySession?.swoSource) {
                mySession.swoSource.dispose();
            }
            if (mySession?.rtt) {
                mySession.rtt.debugSessionTerminated();
            }
            if (mySession?.rttPortMap) {
                for (const ch of Object.keys(mySession.rttPortMap)) {
                    mySession.rttPortMap[parseInt(ch)].dispose();
                }
                mySession.rttPortMap = {};
            }
        } catch (e) {
            vscode.window.showInformationMessage(`Debug session did not terminate cleanly ${e}\n${e ? (e as Error).stack : ''}. Please report this problem`);
        } finally {
            CDebugSession.RemoveSession(session);
        }
    }

    private receivedCustomEvent(e: vscode.DebugSessionCustomEvent) {
        const session = e.session;
        if (session.type !== 'cortex-debug') { return; }
        switch (e.event) {
            case 'custom-stop':
                this.receivedStopEvent(e);
                break;
            case 'custom-continued':
                this.receivedContinuedEvent(e);
                break;
            case 'swo-configure':
                this.receivedSWOConfigureEvent(e);
                break;
            case 'rtt-configure':
                this.receivedRTTConfigureEvent(e);
                break;
            case 'record-event':
                this.receivedEvent(e);
                break;
            case 'custom-event-post-start-server':
                this.startChainedConfigs(e, ChainedEvents.POSTSTART);
                break;
            case 'custom-event-post-start-gdb':
                this.startChainedConfigs(e, ChainedEvents.POSTINIT);
                this.liveWatchProvider?.debugSessionStarted(session);
                break;
            case 'custom-event-session-terminating':
                ServerConsoleLog('Got event for sessions terminating', process.pid);
                this.endChainedConfigs(e);
                break;
            case 'custom-event-session-restart':
                this.resetOrResartChained(e, 'restart');
                break;
            case 'custom-event-session-reset':
                this.resetOrResartChained(e, 'reset');
                break;
            case 'custom-event-popup': {
                const msg = e.body.info?.message;
                switch (e.body.info?.type) {
                    case 'warning':
                        vscode.window.showWarningMessage(msg);
                        break;
                    case 'error':
                        vscode.window.showErrorMessage(msg);
                        break;
                    default:
                        vscode.window.showInformationMessage(msg);
                        break;
                }
                break;
            }
            case 'custom-event-ports-allocated':
                this.registerPortsAsUsed(e);
                break;
            case 'custom-event-ports-done':
                this.signalPortsAllocated(e);
                break;
            default:
                break;
        }
    }

    private signalPortsAllocated(e: vscode.DebugSessionCustomEvent) {
        if (this.serverStartedEvent) {
            this.serverStartedEvent.resolve(e);
            this.serverStartedEvent = undefined;
        }
    }

    private registerPortsAsUsed(e: vscode.DebugSessionCustomEvent) {
        // We can get this event before the session starts
        const mySession = CDebugSession.GetSession(e.session);
        mySession.addUsedPorts(e.body?.info || []);
    }

    private async startChainedConfigs(e: vscode.DebugSessionCustomEvent, evType: ChainedEvents) {
        const adapterArgs = e?.body?.info as ConfigurationArguments;
        const cDbgParent = CDebugSession.GetSession(e.session, adapterArgs);
        if (!adapterArgs || !adapterArgs.chainedConfigurations?.enabled) { return; }
        const unique = adapterArgs.chainedConfigurations.launches.filter((x, ix) => {
            return ix === adapterArgs.chainedConfigurations.launches.findIndex((v, ix) => v.name === x.name);
        });
        const filtered = unique.filter((launch) => {
            return (launch.enabled && (launch.waitOnEvent === evType) && launch.name);
        });

        let delay = 0;
        let count = filtered.length;
        for (const launch of filtered) {
            count--;
            const childOptions: vscode.DebugSessionOptions = {
                consoleMode: vscode.DebugConsoleMode.Separate,
                noDebug: adapterArgs.noDebug,
                compact: false
            };
            if (launch.lifecycleManagedByParent) {
                // VSCode 'lifecycleManagedByParent' does not work as documented. The fact that there
                // is a parent means it is managed and 'lifecycleManagedByParent' if ignored.
                childOptions.lifecycleManagedByParent = true;
                childOptions.parentSession = e.session;
            }
            delay += Math.max(launch.delayMs || 0, 0);
            const child = new CDebugChainedSessionItem(cDbgParent, launch, childOptions);
            const folder = this.getWsFolder(launch.folder, e.session.workspaceFolder, launch.name);
            setTimeout(() => {
                vscode.debug.startDebugging(folder, launch.name, childOptions).then((success) => {
                    if (!success) {
                        vscode.window.showErrorMessage('Failed to launch chained configuration ' + launch.name);
                    }
                    CDebugChainedSessionItem.RemoveItem(child);
                }, (e) => {
                    vscode.window.showErrorMessage(`Failed to launch chained configuration ${launch.name}: ${e}`);
                    CDebugChainedSessionItem.RemoveItem(child);
                });
            }, delay);
            if (launch && launch.detached && (count > 0)) {
                try {
                    // tslint:disable-next-line: one-variable-per-declaration
                    let res!: (value: vscode.DebugSessionCustomEvent) => void;
                    let rej!: (reason?: any) => void;
                    const prevStartedPromise = new Promise<vscode.DebugSessionCustomEvent>((resolve, reject) => {
                        res = resolve;
                        rej = reject;
                    });
                    this.serverStartedEvent = new ServerStartedPromise(launch.name, prevStartedPromise, res, rej);
                    let to: any = setTimeout(() => {
                        if (this.serverStartedEvent) {
                            this.serverStartedEvent.reject(new Error(`Timeout starting chained session: ${launch.name}`));
                            this.serverStartedEvent = undefined;
                        }
                        to = undefined;
                    }, 5000);
                    await prevStartedPromise;
                    if (to) { clearTimeout(to); }
                } catch (e) {
                    vscode.window.showErrorMessage(`Detached chained configuration launch failed? Aborting rest. Error: ${e}`);
                    break;      // No more children after this error
                }
                delay = 0;
            } else {
                delay += 5;
            }
        }
    }

    private endChainedConfigs(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren()) {
            // Note that we may not be the root, but we have children. Also we do not modify the tree while iterating it
            const deathList: CDebugSession[] = [];
            const orphanList: CDebugSession[] = [];
            mySession.broadcastDFS((s) => {
                if (s === mySession) { return; }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    deathList.push(s);      // Qualifies to be terminated
                } else {
                    orphanList.push(s);     // This child is about to get orphaned
                }
            }, false);

            // According to current scheme, there should not be any orphaned children.
            while (orphanList.length > 0) {
                const s = orphanList.pop();
                s?.moveToRoot();     // Or should we move to our parent. TODO: fix for when we are going to have grand children
            }

            while (deathList.length > 0) {
                const s = deathList.pop();
                if (!s) { continue; }
                // We cannot actually use the following API. We have to do this ourselves. Probably because we own
                // the lifetime management.
                // vscode.debug.stopDebugging(s.session);
                ServerConsoleLog(`Sending custom-stop-debugging to ${s.session.name}`, process.pid);
                s.session.customRequest('custom-stop-debugging', e.body.info).then(() => {
                }, (reason) => {
                    vscode.window.showErrorMessage(`Cortex-Debug: Bug? session.customRequest('set-stop-debugging-type', ... failed ${reason}\n`);
                });
            }
            // Following does not work. Apparently, a customRequest cannot be sent probably because this session is already
            // terminating.
            // mySession.session.customRequest('notified-children-to-terminate');
        }
    }

    private resetOrResartChained(e: vscode.DebugSessionCustomEvent, type: 'reset' | 'restart') {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren()) {
            mySession.broadcastDFS((s) => {
                if (s === mySession) { return; }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    s.session.customRequest('reset-device', type).then(() => {
                    }, (reason) => {
                    });
                }
            }, false);
        }
    }

    private getWsFolder(folder: string, def: vscode.WorkspaceFolder | undefined, childName: string): vscode.WorkspaceFolder | undefined {
        if (folder) {
            const orig = folder;
            const normalize = (fsPath: string) => {
                fsPath = path.normalize(fsPath).replace(/\\/g, '/');
                fsPath = (fsPath === '/') ? fsPath : fsPath.replace(/\/+$/, '');
                if (process.platform === 'win32') {
                    fsPath = fsPath.toLowerCase();
                }
                return fsPath;
            };
            // Folder is always a full path name
            folder = normalize(folder);
            if (vscode.workspace.workspaceFolders) {
                for (const f of vscode.workspace.workspaceFolders) {
                    const tmp = normalize(f.uri.fsPath);
                    if ((f.uri.fsPath === folder) || (f.name === folder) || (tmp === folder)) {
                        return f;
                    }
                }
            }
            vscode.window.showInformationMessage(
                `Chained configuration for '${childName}' specified folder is '${orig}' normalized path is '${folder}'`
                + ` but that folder is not open in the workspace. Using '${def ? def.name : 'root'}'`);
        } else {
            // No folder specified. Use the default one (parent's folder)
            return def;
        }
        return def;
    }

    private getCurrentArgs(session: vscode.DebugSession): ConfigurationArguments | undefined {
        const sess = session || vscode.debug.activeDebugSession;
        if (!sess || (sess.type !== 'cortex-debug')) {
            return undefined;
        }
        const ourSession = CDebugSession.FindSession(sess);
        if (ourSession) {
            return ourSession.config as ConfigurationArguments;
        }
        return sess.configuration as unknown as ConfigurationArguments;
    }

    // Assuming 'session' valid and it a cortex-debug session
    private isDebugging(session: vscode.DebugSession) {
        const args = this.getCurrentArgs(session);
        return args && (args.noDebug !== true);       // If it is exactly equal to 'true' we are doing a 'run without debugging'
    }

    private receivedStopEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession) {
            mySession.status = 'stopped';
            this.liveWatchProvider?.debugStopped(e.session);
            vscode.workspace.textDocuments.filter((td) => td.fileName.endsWith('.cdmem')).forEach((doc) => {
                if (!doc.isClosed) {
                    this.memoryProvider.update(doc);
                }
            });
            if (mySession.swo) { mySession.swo.debugStopped(); }
            if (mySession.rtt) { mySession.rtt.debugStopped(); }
        }
    }

    private receivedContinuedEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession) {
            mySession.status = 'running';
            this.liveWatchProvider?.debugContinued(e.session);
            if (mySession.swo) { mySession.swo.debugContinued(); }
            if (mySession.rtt) { mySession.rtt.debugContinued(); }
        }
    }

    private receivedEvent(e: any) {
    }

    private receivedSWOConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.GetSession(e.session);
        if (e.body.type === 'socket') {
            let src;
            if (mySession.config.servertype === 'pe') {
                src = new PeMicroSocketSource(e.body.port);
            } else {
                src = new SocketSWOSource(e.body.port);
            }
            mySession.swoSource = src;
            this.initializeSWO(e.session, e.body.args);
            src.start().then(() => {
                CortexDebugChannel.debugMessage(`Connected after ${src.nTries} tries`);
                // Do nothing...
            }, (e) => {
                vscode.window.showErrorMessage(`Could not open SWO TCP port ${e.body.port} ${e} after ${src.nTries} tries`);
            });
            return;
        } else if (e.body.type === 'fifo') {
            mySession.swoSource = new FifoSWOSource(e.body.path);
        } else if (e.body.type === 'file') {
            mySession.swoSource = new FileSWOSource(e.body.path);
        } else if (e.body.type === 'serial') {
            mySession.swoSource = new SerialSWOSource(e.body.device, e.body.baudRate);
        } else if (e.body.type === 'usb') {
            mySession.swoSource = new UsbSWOSource(e.body.device, e.body.port);
        }

        this.initializeSWO(e.session, e.body.args);
    }

    private receivedRTTConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        if (e.body.type === 'socket') {
            const decoder: RTTCommonDecoderOpts = e.body.decoder;
            if ((decoder.type === 'console') || (decoder.type === 'binary')) {
                this.rttCreateTerninal(e, decoder as RTTConsoleDecoderOpts);
            } else {
                if (!decoder.ports) {
                    this.createRTTSource(e, decoder.tcpPort, decoder.port);
                } else {
                    for (let ix = 0; ix < decoder.ports.length; ix = ix + 1) {
                        // Hopefully ports and tcpPorts are a matched set
                        this.createRTTSource(e, decoder.tcpPorts[ix], decoder.ports[ix]);
                    }
                }
            }
        } else {
            CortexDebugChannel.debugMessage('Error: receivedRTTConfigureEvent: unknown type: ' + e.body.type);
        }
    }

    // The returned value is a connection source. It may still be in disconnected
    // state.
    private createRTTSource(e: vscode.DebugSessionCustomEvent, tcpPort: string, channel: number): Promise<SocketRTTSource> {
        const mySession = CDebugSession.GetSession(e.session);
        return new Promise((resolve, reject) => {
            let src = mySession.rttPortMap[channel];
            if (src) {
                resolve(src);
                return;
            }
            if (mySession.config.servertype === 'jlink') {
                src = new JLinkSocketRTTSource(tcpPort, channel);
            } else {
                src = new SocketRTTSource(tcpPort, channel);
            }
            mySession.rttPortMap[channel] = src;     // Yes, we put this in the list even if start() can fail
            resolve(src);                            // Yes, it is okay to resolve it even though the connection isn't made yet
            src.start().then(() => {
                mySession.session.customRequest('rtt-poll');
            }).catch((e) => {
                vscode.window.showErrorMessage(`Could not connect to RTT TCP port ${tcpPort} ${e}`);
                // reject(e);
            });
        });
    }

    private cleanupRTTTerminals() {
        this.rttTerminals = this.rttTerminals.filter((t) => {
            if (!t.inUse) {
                t.dispose();
                return false;
            }
            return true;
        });
    }

    private rttCreateTerninal(e: vscode.DebugSessionCustomEvent, decoder: RTTConsoleDecoderOpts) {
        this.createRTTSource(e, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
            for (const terminal of this.rttTerminals) {
                const success = !terminal.inUse && terminal.tryReuse(decoder, src);
                if (success) {
                    if (vscode.debug.activeDebugConsole) {
                        vscode.debug.activeDebugConsole.appendLine(
                            `Reusing RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`
                        );
                    }
                    return;
                }
            }
            const newTerminal = new RTTTerminal(this.context, decoder, src);
            this.rttTerminals.push(newTerminal);
            if (vscode.debug.activeDebugConsole) {
                vscode.debug.activeDebugConsole.appendLine(
                    `Created RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`
                );
            }
        });
    }

    private terminalClosed(terminal: vscode.Terminal) {
        this.rttTerminals = this.rttTerminals.filter((t) => t.terminal !== terminal);
    }

    private initializeSWO(session: vscode.DebugSession, args: any) {
        const mySession = CDebugSession.FindSession(session);
        if (!mySession) { return; }
        if (!mySession.swoSource) {
            vscode.window.showErrorMessage('Tried to initialize SWO Decoding without a SWO data source');
            return;
        }

        this.traceView.setSWOSourceReady(session.id, !!mySession.swoSource.connected, args);

        if (!mySession.swo) {
            mySession.swo = new SWOCore(session, mySession.swoSource, args, this.context.extensionPath, this.traceView);
        } else {
            mySession.swo.setTraceSink(this.traceView);
        }
    }

    private initializeRTT(session: vscode.DebugSession, args: any) {
        const mySession = CDebugSession.FindSession(session);
        if (!mySession) { return; }
        if (!mySession.rtt) {
            mySession.rtt = new RTTCore(mySession.rttPortMap, args, this.context.extensionPath);
        }
    }

    private addLiveWatchExpr() {
        vscode.window.showInputBox({
            placeHolder: 'Enter a valid C/gdb expression. Must be a global variable expression',
            ignoreFocusOut: true,
            prompt: 'Enter Live Watch Expression'
        }).then((v) => {
            if (v && vscode.debug.activeDebugSession) {
                this.liveWatchProvider.addWatchExpr(v, vscode.debug.activeDebugSession);
            }
        });
    }

    private async addReceiveStruct(): Promise<void> {
        const active = vscode.debug.activeDebugSession;
        const session = this.nativeLiveWatch.getSession(active) || active;
        if (!session || !session.configuration.liveWatch?.enabled) {
            vscode.window.showWarningMessage('rm_debug：请先启动已启用 Live Watch 的调试会话。');
            return;
        }
        const expr = await vscode.window.showInputBox({
            title: 'rm_debug：监控接收结构体',
            prompt: '输入全局或静态结构体变量表达式；所有字段会自动展开并持续刷新',
            placeHolder: '例如 uart_rx_data',
            ignoreFocusOut: true
        });
        if (!expr?.trim()) { return; }
        const node = this.liveWatchProvider.addWatchExpr(expr, session, true);
        if (node) { await this.liveWatchView.reveal(node.getPlotPath()); }
    }

    private async addFileStatic(): Promise<void> {
        const active = vscode.debug.activeDebugSession;
        const session = this.nativeLiveWatch.getSession(active) || active;
        if (!session || !session.configuration.liveWatch?.enabled) {
            void vscode.window.showWarningMessage('rm_debug：请先启动已启用 Live Watch 的调试会话。');
            return;
        }
        const currentFile = vscode.window.activeTextEditor?.document.uri.fsPath || '';
        const file = await vscode.window.showInputBox({
            title: 'rm_debug：选择文件内 static 变量',
            prompt: '输入定义该变量的 .c 文件路径',
            value: currentFile,
            ignoreFocusOut: true
        });
        if (!file?.trim()) { return; }
        let names: string[] = [];
        try {
            const result = await session.customRequest('list-file-statics', { file: file.trim() });
            names = (result?.names || []).filter((name: string) => /^[A-Za-z_]\w*$/.test(name));
        } catch (error) {
            void vscode.window.showWarningMessage(`rm_debug：读取 static 符号列表失败：${error}`);
        }
        const selected = names.length
            ? await vscode.window.showQuickPick([...new Set(names)].sort(), {
                title: 'rm_debug：选择文件内 static 变量', placeHolder: '选择要实时监控的变量'
            })
            : await vscode.window.showInputBox({
                title: 'rm_debug：输入 static 变量名',
                prompt: '符号列表中没有找到可选变量；请输入文件内 static 变量名',
                ignoreFocusOut: true
            });
        if (!selected) { return; }
        const normalized = file.trim().replace(/\\/g, '/').replace(/'/g, `\\'`);
        const node = this.liveWatchProvider.addWatchExpr(`'${normalized}'::${selected}`, session);
        if (node) { await this.liveWatchView.reveal(node.getPlotPath()); }
    }

    private async setLiveWatchRate(): Promise<void> {
        const current = this.liveWatchProvider.getSamplingRate();
        const choice = await vscode.window.showQuickPick(
            ['1 Hz', '2 Hz', '5 Hz', '10 Hz', '20 Hz', '自定义…'],
            { title: `rm_debug：选择 Live Watch 目标采样频率（当前 ${current} Hz）` }
        );
        if (!choice) { return; }
        const input = choice === '自定义…'
            ? await vscode.window.showInputBox({
                title: 'rm_debug：目标采样频率', value: String(current), prompt: '输入 1 到 20 Hz 的数值',
                validateInput: (value) => {
                    const rate = Number(value);
                    return Number.isFinite(rate) && rate >= 1 && rate <= 20 ? undefined : '请输入 1 到 20 之间的数值';
                }
            })
            : choice.split(' ')[0];
        if (input === undefined) { return; }
        if (!this.liveWatchProvider.setSamplingRate(Number(input))) {
            vscode.window.showWarningMessage('rm_debug：请先启动已启用 Live Watch 的 OpenOCD 调试会话。');
        }
    }

    private async setLiveWatchNumberFormat(): Promise<void> {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const current = config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true);
        const choice = await vscode.window.showQuickPick([
            { label: '十进制 (10)', description: current ? '当前使用' : '', decimal: true },
            { label: '十六进制 (0x)', description: current ? '' : '当前使用', decimal: false }
        ], { title: 'rm_debug：选择变量数值显示进制' });
        if (!choice || choice.decimal === current) { return; }
        const [target, languageOverride] = this.getConfigSource(config, CortexDebugKeys.VARIABLE_DISPLAY_MODE);
        await config.update(CortexDebugKeys.VARIABLE_DISPLAY_MODE, choice.decimal, target, languageOverride);
        await vscode.commands.executeCommand(
            'setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`, choice.decimal
        );
    }

    private async toggleMonitorAll(node: LiveVariableNode): Promise<void> {
        const enabled = this.liveWatchProvider.toggleMonitorAll(node);
        if (enabled) { await this.liveWatchView.reveal(node.getPlotPath()); }
    }

    private dapLivePlotSession(): vscode.DebugSession | undefined {
        const session = LiveWatchTreeProvider.session;
        const files = session?.configuration?.configFiles;
        const isDap = session?.configuration?.servertype === 'openocd'
            && ((Array.isArray(files) && files.some((file) => /cmsis[-_]dap\.cfg$/i.test(String(file))))
                || /DAP.?Link|CMSIS.?DAP/i.test(session?.configuration?.name || ''));
        if (!isDap) {
            vscode.window.showWarningMessage('rm_debug：首版 Live Plot 需要正在运行的 DAPLink / CMSIS-DAP Live Watch 调试会话。');
            return undefined;
        }
        return session;
    }

    private showLivePlot(): void {
        if (!this.dapLivePlotSession()) { return; }
        if (!this.livePlotPanel) {
            const panel = new LivePlotPanel(this.context, this.liveWatchProvider, () => {
                if (this.livePlotPanel === panel) { this.livePlotPanel = undefined; }
            });
            this.livePlotPanel = panel;
        }
        this.livePlotPanel.reveal();
    }

    private async showPlotPicker(): Promise<void> {
        const selected = await vscode.window.showQuickPick([
            { label: '调试接口直接读取', description: 'DAP-Link + Live Watch，无需修改固件；当前约 5 Hz', mode: 'live' },
            { label: '串口上传出图', description: 'MCU 主动发送样本；示例固件目标约 50 Hz', mode: 'serial' }
        ], { title: 'rm_debug：选择波形数据来源' });
        if (selected?.mode === 'live') {
            this.showLivePlot();
        } else if (selected?.mode === 'serial') {
            await this.showSerialPlot();
        }
    }

    private addToLivePlot(node: LiveVariableNode): void {
        if (node?.getSerialChannel()) {
            void this.addToSerialPlot(node);
            return;
        }
        if (!this.dapLivePlotSession()) { return; }
        if (!node?.getPlotPath() || node.getPlotValue() === undefined) {
            vscode.window.showWarningMessage('rm_debug：请选择 Live Watch 中已读取的整数或浮点数值字段。');
            return;
        }
        this.showLivePlot();
        this.livePlotPanel?.add(node);
    }

    private async showSerialPlot(): Promise<void> {
        if (this.serialPlot) {
            this.serialPlot.reveal();
            return;
        }
        let ports: Awaited<ReturnType<typeof import('serialport').SerialPort.list>>;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { SerialPort } = require('serialport') as typeof import('serialport');
            ports = await SerialPort.list();
        } catch (error) {
            void vscode.window.showErrorMessage(`rm_debug：无法枚举串口：${String(error)}`);
            return;
        }
        const choices = ports.map((port) => ({
            label: port.path,
            description: [port.manufacturer, port.pnpId].filter(Boolean).join(' · '),
            path: port.path
        }));
        const example = process.platform === 'win32' ? 'COM3' : '/dev/ttyACM0';
        choices.push({ label: '手动输入串口…', description: `例如 ${example}`, path: '' });
        const selected = await vscode.window.showQuickPick(choices, { title: 'rm_debug：选择接收 MCU 波形的串口（115200 8N1）' });
        if (!selected) { return; }
        const portPath = selected.path || await vscode.window.showInputBox({
            title: 'rm_debug：串口', prompt: `输入 DAP-Link 虚拟串口，例如 ${example}`, placeHolder: example
        });
        if (!portPath?.trim()) { return; }
        try {
            const panel = new SerialPlot(this.context, portPath.trim(), () => {
                if (this.serialPlot === panel) { this.serialPlot = undefined; }
                this.liveWatchProvider.serialSourceClosed();
            }, (values, _timestampMs, actualHz) => this.liveWatchProvider.onSerialSample(values, actualHz));
            this.serialPlot = panel;
        } catch (error) {
            void vscode.window.showErrorMessage(`rm_debug：启动串口波形失败：${String(error)}`);
        }
    }

    private async addToSerialPlot(node: LiveVariableNode): Promise<void> {
        const id = node?.getSerialChannel() || node?.getPlotPath();
        if (!id) {
            vscode.window.showWarningMessage('rm_debug：请选择一个变量字段。');
            return;
        }
        if (!this.serialPlot) { await this.showSerialPlot(); }
        this.serialPlot?.addChannel(id);
    }

    private async addSerialChannelToLiveWatch(): Promise<void> {
        const channels = this.serialPlot?.getAvailableChannels() || [];
        let channel: string | undefined;
        if (channels.length) {
            const choices = channels.map((id) => ({ label: id, id }));
            choices.push({ label: '手动输入通道名…', id: '' });
            const selected = await vscode.window.showQuickPick(choices, {
                title: 'rm_debug：选择串口变量加入 Live Watch'
            });
            if (!selected) { return; }
            channel = selected.id || undefined;
        }
        if (!channel) {
            channel = await vscode.window.showInputBox({
                title: 'rm_debug：串口变量名',
                prompt: '输入固件 RM2 帧中的变量名，例如 motor_speed',
                ignoreFocusOut: true
            });
        }
        if (!channel) { return; }
        const node = this.liveWatchProvider.addSerialChannel(channel);
        if (!node) {
            void vscode.window.showWarningMessage('rm_debug：通道名需符合 RM2 格式，例如 motor_speed 或 motor.speed。');
            return;
        }
        if (!this.serialPlot) { await this.showSerialPlot(); }
        await this.liveWatchView.reveal(node.getPlotPath());
    }

    private async gotoFunctionTarget(node: LiveVariableNode): Promise<void> {
        const target = node?.getFunctionTarget();
        if (!target) {
            vscode.window.showWarningMessage('rm_debug：当前指针地址没有匹配的函数符号。');
            return;
        }
        const exactLocation = this.addr2lineLocation(target);
        if (exactLocation) {
            await vscode.window.showTextDocument(exactLocation.uri, {
                selection: exactLocation.range, preview: false
            });
            return;
        }
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', target.name
        ) || [];
        const exact = symbols.filter((item) => item.name === target.name || item.name.startsWith(`${target.name}(`));
        const matchingFile = typeof target.file === 'string'
            ? exact.find((item) => path.basename(item.location.uri.fsPath) === path.basename(target.file as string))
            : undefined;
        let selected = matchingFile || exact[0];
        if (exact.length > 1 && !matchingFile) {
            const choice = await vscode.window.showQuickPick(exact.map((item) => ({
                label: item.name, description: item.location.uri.fsPath, symbol: item
            })), { placeHolder: `选择 ${target.name} 的定义` });
            selected = choice?.symbol;
        }
        if (selected) {
            await vscode.window.showTextDocument(selected.location.uri, {
                selection: selected.location.range, preview: false
            });
        } else if (typeof target.file === 'string' && fs.existsSync(target.file)) {
            await vscode.window.showTextDocument(vscode.Uri.file(target.file), { preview: false });
            vscode.window.showInformationMessage(`rm_debug：已打开 ${target.name} 所在文件；符号表未提供精确行号。`);
        } else {
            vscode.window.showWarningMessage(`rm_debug：已解析目标 ${target.name}，但没有找到源码位置。请检查 C/C++ 索引和编译数据库。`);
        }
    }

    private addr2lineLocation(target: SymbolInformation): vscode.Location | undefined {
        const gcc = vscode.workspace.getConfiguration('rm-debug').get<string>('armGccPath', '');
        const addr2line = path.join(path.dirname(gcc), toolName('arm-none-eabi-addr2line'));
        const session = vscode.debug.activeDebugSession;
        const folder = vscode.workspace.workspaceFolders?.[0];
        const executable = String(session?.configuration?.executable || '')
            .replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath || '');
        if (!fs.existsSync(addr2line) || !fs.existsSync(executable)) { return undefined; }
        try {
            const output = execFileSync(addr2line, [
                '-f', '-C', '-e', executable, `0x${target.address.toString(16)}`
            ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            const sourceLine = output.trim().split(/\r?\n/).at(-1) || '';
            const match = sourceLine.match(/^(.+?):(\d+)(?::\d+)?$/);
            if (!match || match[1] === '??' || Number(match[2]) < 1) { return undefined; }
            const source = process.platform === 'win32'
                ? match[1].replace(/^\/([a-z])\//i, (_part, drive: string) => `${drive.toUpperCase()}:\\`)
                : match[1];
            const cwd = String(session?.configuration?.cwd || '')
                .replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath || '');
            const candidates = [source, path.resolve(cwd || path.dirname(executable), source)];
            const file = candidates.find((candidate) => fs.existsSync(candidate));
            if (!file) { return undefined; }
            return new vscode.Location(vscode.Uri.file(file), new vscode.Position(Number(match[2]) - 1, 0));
        } catch (_error) { return undefined; }
    }

    private addToLiveWatch(arg: any, monitorAll = false) {
        if (!arg || !arg.sessionId) {
            return;
        }
        const native = this.nativeLiveWatch.getSession(vscode.debug.activeDebugSession);
        if (native?.id === arg.sessionId && arg.variable?.evaluateName) {
            const node = this.liveWatchProvider.addWatchExpr(arg.variable.evaluateName, native, monitorAll);
            if (node) { void this.liveWatchView.reveal(node.getPlotPath()); }
            return;
        }
        const mySession = CDebugSession.FindSessionById(arg.sessionId);
        if (!mySession) {
            vscode.window.showErrorMessage(`addToLiveWatch: Unknown debug session id ${arg.sessionId}`);
            return;
        }
        const parent = arg.container;
        const expr = arg.variable?.evaluateName;
        if (parent && expr) {
            const varRef = parent.variablesReference;
            mySession.session.customRequest('is-global-or-static', { varRef: varRef }).then((result) => {
                if (!result.success) {
                    vscode.window.showErrorMessage(`Cannot add ${expr} to Live Watch. Must be a global or static variable`);
                } else if (vscode.debug.activeDebugSession) {
                    const node = this.liveWatchProvider.addWatchExpr(expr, vscode.debug.activeDebugSession, monitorAll);
                    if (node && monitorAll) {
                        void this.liveWatchView.reveal(node.getPlotPath());
                    }
                }
            }, (e) => {
                console.log(e);
            });
        }
    }

    private async pinLocalToLiveWatch(arg: any): Promise<void> {
        const mySession = arg?.sessionId ? CDebugSession.FindSessionById(arg.sessionId) : undefined;
        const session = mySession?.session;
        if (!session || !session.configuration.liveWatch?.enabled) {
            void vscode.window.showWarningMessage('rm_debug：请先启动已启用 Live Watch 的调试会话。');
            return;
        }
        const name = String(arg?.variable?.name || '');
        const expression = String(arg?.variable?.evaluateName || (/^[A-Za-z_]\w*$/.test(name) ? name : ''));
        const varRef = arg?.container?.variablesReference;
        if (!expression || !Number.isInteger(varRef)) {
            void vscode.window.showWarningMessage('rm_debug：请选择有可求值表达式的局部变量。');
            return;
        }
        try {
            const result = await session.customRequest('pin-live-local', { varRef, expression });
            const info: PinnedLocalInfo = {
                address: result.address,
                functionName: result.functionName || '',
                sourceFile: result.sourceFile || '',
                sourceExpression: result.sourceExpression || expression
            };
            const node = this.liveWatchProvider.addPinnedLocal(name || expression, result.expression, info, session);
            if (node) {
                await this.liveWatchView.reveal(node.getPlotPath());
                void vscode.window.showInformationMessage(
                    `rm_debug：已高速监控 ${name || expression} 的固定地址 ${info.address}。函数返回后地址可能被复用。`);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`rm_debug：无法监控局部变量：${error}`);
        }
    }

    private removeLiveWatchExpr(node: any) {
        this.liveWatchProvider.removeWatchExpr(node);
    }

    private editLiveWatchExpr(node: any) {
        this.liveWatchProvider.editNode(node);
    }

    private moveUpLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveUpNode(node);
    }

    private moveDownLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveDownNode(node);
    }
}

export function activate(context: vscode.ExtensionContext) {
    try {
        CortexDebugChannel.createDebugChanne();
        CortexDebugChannel.debugMessage('Starting Cortex-Debug extension.');
    } catch (_e) { /* empty */ }

    return new CortexDebugExtension(context);
}

export function deactivate() { }
