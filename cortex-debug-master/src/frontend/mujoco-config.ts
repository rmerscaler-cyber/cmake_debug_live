import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';

export const MUJOCO_LAUNCH = 'rm_debug: MuJoCo C++（窗口）';
export const MUJOCO_HEADLESS = 'rm_debug: MuJoCo C++（无窗口）';
export const MUJOCO_CONFIGURE_TASK = 'rm_debug: Configure MuJoCo Debug';
export const MUJOCO_BUILD_TASK = 'rm_debug: Build MuJoCo Debug';

export interface MujocoOptions {
    python: string;
    gdb: string;
    cmake: string;
    compiler: string;
    source: string;
    build: string;
    script: string;
    cwd: string;
    duration: number;
}

export function isMujocoLaunch(config: Record<string, any>): boolean {
    return config.type === 'cppdbg' && config.request === 'launch' && config.MIMode === 'gdb'
        && (/mujoco/i.test(config.name || '')
            || (Array.isArray(config.args) && config.args.some((arg) => typeof arg === 'string' && /(?:^|[/\\])run_sim\.py$/.test(arg))));
}

export function isHeadlessLaunch(config: Record<string, any>): boolean {
    return (Array.isArray(config.args) && config.args.includes('--headless')) || /headless|无窗口/i.test(config.name || '');
}

export function mujocoConfiguration(options: MujocoOptions): { launches: Array<Record<string, any>>; tasks: Array<Record<string, any>> } {
    if (!Number.isFinite(options.duration) || options.duration <= 0) { throw new Error('无窗口仿真时长必须大于 0。'); }
    const launch = {
        name: MUJOCO_LAUNCH, type: 'cppdbg', request: 'launch', program: options.python,
        args: [options.script, '--embedded'], cwd: options.cwd, stopAtEntry: false,
        environment: [{ name: 'PYTHONUNBUFFERED', value: '1' }], externalConsole: false,
        MIMode: 'gdb', miDebuggerPath: options.gdb, additionalSOLibSearchPath: options.build,
        setupCommands: [
            { text: '-enable-pretty-printing', ignoreFailures: true },
            { text: '-gdb-set breakpoint pending on' }
        ],
        preLaunchTask: MUJOCO_BUILD_TASK
    };
    return {
        launches: [launch, { ...launch, name: MUJOCO_HEADLESS,
            args: [...launch.args, '--headless', '--duration', String(options.duration)] }],
        tasks: [
            { label: MUJOCO_CONFIGURE_TASK, type: 'process', command: options.cmake,
                args: ['-S', options.source, '-B', options.build, '-DCMAKE_BUILD_TYPE=Debug',
                    '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', `-DCMAKE_CXX_COMPILER=${options.compiler}`],
                options: { cwd: options.cwd }, problemMatcher: ['$gcc'] },
            { label: MUJOCO_BUILD_TASK, type: 'process', command: options.cmake,
                args: ['--build', options.build, '--config', 'Debug', '--parallel', '2'],
                options: { cwd: options.cwd }, dependsOn: [MUJOCO_CONFIGURE_TASK], dependsOrder: 'sequence',
                problemMatcher: ['$gcc'], group: { kind: 'build', isDefault: false } }
        ]
    };
}

// Only replace our own entries. Existing simulation, desktop and probe configurations survive.
export function mergeMujocoFile(text: string, key: 'tasks' | 'configurations', items: Array<Record<string, any>>): string {
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)
        || (value[key] !== undefined && !Array.isArray(value[key]))) {
        throw new Error(`配置文件格式无效：${key}`);
    }
    const identity = key === 'tasks' ? 'label' : 'name';
    const previous: Array<Record<string, any>> = value[key] || [];
    const next = items.map((item) => {
        if (key === 'tasks') { return item; }
        const old = previous.find((entry) => entry.name === item.name);
        if (!old) { return item; }
        const environment = Array.isArray(old.environment) ? old.environment : [];
        const setup = Array.isArray(old.setupCommands) ? old.setupCommands : [];
        return { ...old, ...item, args: Array.isArray(old.args) && old.args.length ? [item.args[0], ...old.args.slice(1)] : item.args,
            environment: [...item.environment, ...environment.filter((entry) => !item.environment.some((other) => other.name === entry.name))],
            setupCommands: [...item.setupCommands, ...setup.filter((entry) => !item.setupCommands.some((other) => other.text === entry.text))] };
    });
    return applyEdits(text, modify(text, [key],
        [...previous.filter((entry) => !items.some((item) => item[identity] === entry[identity])), ...next],
        { formattingOptions: { insertSpaces: true, tabSize: 4 } }));
}
