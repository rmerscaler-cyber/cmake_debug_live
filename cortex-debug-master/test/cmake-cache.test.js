const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { backupRelocatedCMakeCache } = require('../out/src/frontend/cmake-cache');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-debug-cache-'));
const project = path.join(temporary, 'source project');
const build = path.join(project, 'build');
fs.mkdirSync(build, { recursive: true });
const cache = path.join(build, 'CMakeCache.txt');
const detected = path.join(build, 'CMakeFiles');
const cacheText = (source, binary) => `CMAKE_HOME_DIRECTORY:INTERNAL=${source}\r\nCMAKE_CACHEFILE_DIR:INTERNAL=${binary}\r\n`;
try {
    assert.strictEqual(backupRelocatedCMakeCache(project, build), undefined);
    fs.writeFileSync(cache, cacheText(project, build));
    assert.strictEqual(backupRelocatedCMakeCache(project, build), undefined, 'normal incremental builds keep their cache');
    fs.mkdirSync(detected);
    fs.writeFileSync(path.join(detected, 'compiler.cmake'), 'D:/Windows/gcc.exe');
    fs.writeFileSync(path.join(build, 'firmware.elf'), 'keep firmware');
    const windowsCache = cacheText('E:/code_for_rm/project', 'E:/code_for_rm/project/build');
    fs.writeFileSync(cache, windowsCache);
    const backup = backupRelocatedCMakeCache(project, build);
    assert(backup && backup.previousProject === 'E:/code_for_rm/project');
    assert.strictEqual(fs.readFileSync(path.join(backup.directory, 'CMakeCache.txt'), 'utf8'), windowsCache);
    assert(fs.existsSync(path.join(backup.directory, 'CMakeFiles/compiler.cmake')));
    assert(!fs.existsSync(cache) && !fs.existsSync(detected));
    assert.strictEqual(fs.readFileSync(path.join(build, 'firmware.elf'), 'utf8'), 'keep firmware');

    fs.writeFileSync(cache, cacheText(project, '/old/build'));
    assert(backupRelocatedCMakeCache(project, build), 'a moved build directory also requires fresh detection');
    fs.writeFileSync(cache, cacheText('/old/project', '/old/build'));
    fs.mkdirSync(detected);
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
        if (source === detected) { throw new Error('simulated move failure'); }
        return rename(source, destination);
    };
    try {
        assert.throws(() => backupRelocatedCMakeCache(project, build), /simulated move failure/);
    } finally { fs.renameSync = rename; }
    assert(fs.existsSync(cache) && fs.existsSync(detected), 'failed backup must roll back');

    const cmake = process.argv[2];
    if (cmake) {
        fs.writeFileSync(path.join(project, 'CMakeLists.txt'),
            'cmake_minimum_required(VERSION 3.16)\nproject(cache_check LANGUAGES C)\nadd_executable(app main.c)\n');
        fs.writeFileSync(path.join(project, 'main.c'), 'int main(void) { return 0; }\n');
        const run = (args) => {
            const result = spawnSync(cmake, args, { encoding: 'utf8', timeout: 30000 });
            assert.ifError(result.error);
            return result;
        };
        const args = ['-S', project, '-B', build, '-G', 'Ninja'];
        fs.writeFileSync(cache, windowsCache);
        const failed = run(args);
        assert.notStrictEqual(failed.status, 0, 'reproduce the reported configuration failure');
        assert(failed.stderr.includes('does not match'));
        backupRelocatedCMakeCache(project, build);
        const configured = run(args);
        assert.strictEqual(configured.status, 0, configured.stderr);
        const built = run(['--build', build]);
        assert.strictEqual(built.status, 0, built.stderr);
        assert(fs.existsSync(path.join(build, process.platform === 'win32' ? 'app.exe' : 'app')));
    }
    console.log('CMake cache migration: preservation, rollback, incremental builds and reconfiguration passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
