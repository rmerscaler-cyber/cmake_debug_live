// Run with: node test/mixed-build-smoke.test.js <gcc> <g++> <gdb> <cmake> <ninja> [arm-toolchain-bin]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Module = require('module');
const { desktopConfiguration } = require('../out/src/frontend/desktop-config');
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
    return request === 'vscode' ? { TreeItem: class {} } : originalLoad.call(this, request, parent, main);
};
const { mixedCMakeLanguages, mixedCMakeCppStandard, cmakeReferencesCpp } = require('../out/src/frontend/cmake-project');
Module._load = originalLoad;
const [gcc, cpp, gdb, cmake, ninja, armBin] = process.argv.slice(2);
assert(gcc && cpp && gdb && cmake && ninja, 'Provide native gcc, g++, gdb, cmake and ninja paths');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-mixed-smoke-'));
assert.strictEqual(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()), 'cleanup stays within the temporary directory');
const source = path.join(temporary, 'mixed project');
fs.mkdirSync(source);
const example = path.resolve(__dirname, '../../test_cpp');
for (const name of ['main.c', 'c_math.c', 'cpp_module.cpp', 'mixed_api.h']) {
    fs.copyFileSync(path.join(example, name), path.join(source, name));
}
const cOnly = 'cmake_minimum_required(VERSION 3.16)\n'
    + 'set(CMAKE_CXX_STANDARD 17 CACHE STRING "Previous C++ standard")\n'
    + 'set(CMAKE_CXX_STANDARD_REQUIRED OFF)\nproject(mixed LANGUAGES C)\n'
    + 'add_executable(app main.c c_math.c cpp_module.cpp)\n'
    + 'target_compile_features(app PRIVATE c_std_11 cxx_std_11)\n';
const fixed = mixedCMakeCppStandard(mixedCMakeLanguages(cOnly));
fs.appendFileSync(path.join(source, 'cpp_module.cpp'), '\nstatic_assert(__cplusplus >= 202002L, "C++20 is required");\n');
fs.writeFileSync(path.join(source, 'CMakeLists.txt'), fixed);
assert(cmakeReferencesCpp(source));
const toolPaths = [gcc, cpp, gdb, cmake, ninja].map((tool) => path.dirname(tool));
const environment = { ...process.env, PATH: [...new Set(toolPaths)].join(path.delimiter) + path.delimiter + process.env.PATH };
function run(command, args, env = environment) {
    const result = spawnSync(command, args, { cwd: source, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
}
try {
    const buildDirectory = path.join(temporary, 'native build');
    const executable = path.join(buildDirectory, process.platform === 'win32' ? 'app.exe' : 'app');
    const config = desktopConfiguration({
        platform: process.platform, debugger: 'gdb', mode: 'cmake', compiler: cpp, cCompiler: gcc, debuggerPath: gdb,
        cmake, ninja, project: source, buildDirectory, program: executable
    });
    config.tasks[0].args.push('-DCMAKE_CXX_STANDARD=17');
    for (const task of config.tasks) {
        run(task.command, task.args);
    }
    assert(run(executable, []).includes('total = 30'), 'C -> C++ -> C calls must produce the correct result');
    const database = JSON.parse(fs.readFileSync(path.join(buildDirectory, 'compile_commands.json'), 'utf8'));
    assert.strictEqual(database.length, 3);
    const c = database.find((entry) => entry.file.replace(/\\/g, '/').endsWith('/main.c'));
    const cxx = database.find((entry) => entry.file.replace(/\\/g, '/').endsWith('/cpp_module.cpp'));
    assert(c.command.includes('gcc') && !c.command.includes('g++'), '.c must retain C semantics');
    assert(cxx.command.includes('g++'), '.cpp must use the C++ compiler');
    assert(/-std=(gnu|c)\+\+20\b/.test(cxx.command), 'C++ builds must use C++20');
    const debug = run(gdb, ['--batch', '-q', executable,
        '-ex', 'break cpp_accumulate', '-ex', 'break c_double', '-ex', 'run', '-ex', 'print value',
        '-ex', 'step', '-ex', 'continue', '-ex', 'backtrace', '-ex', 'print value']);
    assert(debug.includes('cpp_accumulate') && debug.includes('Counter::add') && debug.includes('c_double') && debug.includes('main'),
        'GDB must cross C/C++ boundaries and expose the mixed call stack');
    assert(/\$1 = 1/.test(debug) && /\$2 = 1/.test(debug), 'arguments must be readable in C and C++ frames');
    console.log('Native mixed build, runtime result, GDB breakpoints, stepping, variables and mixed call stack passed');
    if (armBin) {
        const suffix = process.platform === 'win32' ? '.exe' : '';
        const armGcc = path.join(armBin, 'arm-none-eabi-gcc' + suffix);
        const armCpp = path.join(armBin, 'arm-none-eabi-g++' + suffix);
        const armEnv = { ...environment, PATH: armBin + path.delimiter + environment.PATH };
        const armSource = 'cmake_minimum_required(VERSION 3.16)\nproject(mixed_arm LANGUAGES C ASM)\n'
            + 'add_library(mixed STATIC c_math.c cpp_module.cpp)\n'
            + 'target_compile_features(mixed PRIVATE c_std_11 cxx_std_11)\n'
            + 'target_compile_options(mixed PRIVATE -mcpu=cortex-m3 -mthumb -fno-unwind-tables $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>)\n'
            + 'add_executable(firmware arm_main.c)\nset_target_properties(firmware PROPERTIES SUFFIX .elf)\n'
            + 'target_link_libraries(firmware PRIVATE mixed)\n'
            + 'target_compile_options(firmware PRIVATE -mcpu=cortex-m3 -mthumb)\n'
            + 'target_link_options(firmware PRIVATE -mcpu=cortex-m3 -mthumb -nostdlib -Wl,-e,_start -Wl,-Ttext=0x08000000)\n';
        fs.writeFileSync(path.join(source, 'arm_main.c'), '#include "mixed_api.h"\nvolatile int result;\n'
            + 'void _start(void) { result = cpp_accumulate(3); for (;;) {} }\n');
        fs.writeFileSync(path.join(source, 'CMakeLists.txt'), mixedCMakeCppStandard(mixedCMakeLanguages(armSource)));
        const armBuild = path.join(temporary, 'arm build');
        run(cmake, ['-S', source, '-B', armBuild, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`,
            '-DCMAKE_SYSTEM_NAME=Generic', '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY', '-DCMAKE_BUILD_TYPE=Debug',
            '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', `-DCMAKE_C_COMPILER=${armGcc}`, `-DCMAKE_CXX_COMPILER=${armCpp}`, `-DCMAKE_ASM_COMPILER=${armGcc}`],
        armEnv);
        run(cmake, ['--build', armBuild], armEnv);
        assert(fs.existsSync(path.join(armBuild, 'libmixed.a')));
        const firmware = path.join(armBuild, 'firmware.elf');
        const elf = fs.readFileSync(firmware);
        assert.strictEqual(elf.readUInt16LE(18), 40, 'mixed firmware must be an ARM ELF');
        const symbols = run(path.join(armBin, 'arm-none-eabi-nm' + suffix), ['-C', firmware], armEnv);
        assert(symbols.includes('cpp_accumulate') && symbols.includes('c_double') && symbols.includes('Counter::add'),
            'the final firmware must contain both C and C++ functions');
        const armDatabase = JSON.parse(fs.readFileSync(path.join(armBuild, 'compile_commands.json'), 'utf8'));
        assert(armDatabase.some((entry) => entry.command.includes('arm-none-eabi-gcc')));
        assert(armDatabase.some((entry) => entry.command.includes('arm-none-eabi-g++')));
        assert(armDatabase.filter((entry) => entry.file.endsWith('.cpp')).every((entry) => /-std=(gnu|c)\+\+20\b/.test(entry.command)));
        console.log('ARM Cortex-M3 mixed C/C++ compilation and ELF linking passed');
    }
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
