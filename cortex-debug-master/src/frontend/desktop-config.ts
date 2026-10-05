import * as path from 'path';

export const DESKTOP_LAUNCH_NAME = 'rm_debug: Desktop C/C++';
export const DESKTOP_BUILD_TASK = 'rm_debug: Build Desktop C/C++';
export const DESKTOP_CONFIGURE_TASK = 'rm_debug: Configure Desktop CMake';
export type DesktopDebugger = 'gdb' | 'msvc' | 'lldb';
export type DesktopBuildMode = 'file' | 'cmake' | 'executable';

export interface DesktopOptions {
    platform: NodeJS.Platform;
    debugger: DesktopDebugger;
    mode: DesktopBuildMode;
    compiler: string;
    cCompiler: string;
    debuggerPath: string;
    cmake: string;
    ninja: string;
    project: string;
    buildDirectory: string;
    program: string;
}

export function isCppSource(file: string): boolean {
    return /\.(?:cpp|cc|cxx|c\+\+|C)$/.test(file) || /\.(?:cpp|cc|cxx)$/i.test(file);
}

export function isCOrCppSource(file: string): boolean {
    return /\.c$/i.test(file) || isCppSource(file);
}

export function nativeCompiler(file: string): boolean {
    return !/(?:arm-none-eabi|aarch64-none|riscv\d*-|xtensa-)/i.test(path.basename(file));
}

export function desktopConfiguration(options: DesktopOptions): { launch: Record<string, any>; tasks: Array<Record<string, any>> } {
    const windows = options.platform === 'win32';
    const binDirectories = [...new Set([options.compiler, options.cCompiler, options.debuggerPath, options.cmake, options.ninja]
        .filter(Boolean).map((file) => path.dirname(file)))];
    const environment = binDirectories.length
        ? { PATH: [...binDirectories, '${env:PATH}'].join(windows ? ';' : ':') }
        : {};
    const task = (label: string, command: string, args: string[], cwd: string, matcher: string): any => ({
        label, type: 'process', command, args, options: { cwd, env: environment }, problemMatcher: [matcher]
    });
    const tasks: Array<Record<string, any>> = [];
    const fileProgram = '${fileDirname}/${fileBasenameNoExtension}' + (windows ? '.exe' : '');
    if (options.mode === 'file') {
        const args = options.debugger === 'msvc'
            ? ['/nologo', '/EHsc', '/Zi', '/Od', '${command:rm-debug.desktop.standard}', '${file}', `/Fe:${fileProgram}`, '/link', '/DEBUG']
            : ['-g', '-O0', '${command:rm-debug.desktop.standard}', '${file}', '-o', fileProgram];
        tasks.push(task(DESKTOP_BUILD_TASK, '${command:rm-debug.desktop.compiler}', args,
            '${fileDirname}', options.debugger === 'msvc' ? '$msCompile' : '$gcc'));
    } else if (options.mode === 'cmake') {
        const configureArgs = ['-S', options.project, '-B', options.buildDirectory,
            '-DCMAKE_BUILD_TYPE=Debug', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'];
        if (options.debugger !== 'msvc') {
            // Avoid a system default generator selecting MSVC for a MinGW build on Windows.
            configureArgs.push('-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${options.ninja}`,
                `-DCMAKE_C_COMPILER=${options.cCompiler}`, `-DCMAKE_CXX_COMPILER=${options.compiler}`);
        }
        tasks.push(task(DESKTOP_CONFIGURE_TASK, options.cmake, configureArgs, options.project, '$gcc'));
        const build = task(DESKTOP_BUILD_TASK, options.cmake,
            ['--build', options.buildDirectory, '--config', 'Debug', '--parallel'], options.project,
            options.debugger === 'msvc' ? '$msCompile' : '$gcc');
        build.dependsOn = [DESKTOP_CONFIGURE_TASK];
        build.dependsOrder = 'sequence';
        tasks.push(build);
    }
    if (tasks.length) { tasks[tasks.length - 1].group = { kind: 'build', isDefault: false }; }
    const launch: Record<string, any> = {
        name: DESKTOP_LAUNCH_NAME,
        type: options.debugger === 'msvc' ? 'cppvsdbg' : 'cppdbg', request: 'launch',
        program: options.mode === 'file' ? fileProgram : options.program,
        args: [], stopAtEntry: false,
        cwd: options.mode === 'file' ? '${fileDirname}' : options.project,
        environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
        externalConsole: false
    };
    if (tasks.length) { launch.preLaunchTask = DESKTOP_BUILD_TASK; }
    if (options.debugger !== 'msvc') {
        launch.MIMode = options.debugger;
        launch.miDebuggerPath = options.debuggerPath;
        if (options.debugger === 'gdb') {
            launch.setupCommands = [{ description: 'Enable C++ pretty printing', text: '-enable-pretty-printing', ignoreFailures: true }];
        }
    } else {
        launch.console = 'integratedTerminal';
        delete launch.externalConsole;
    }
    return { launch, tasks };
}
