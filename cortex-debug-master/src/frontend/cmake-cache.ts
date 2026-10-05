import * as fs from 'fs';
import * as path from 'path';

export interface CMakeCacheBackup {
    previousProject: string;
    previousBuildDirectory: string;
    directory: string;
}

function sameLocation(left: string, right: string): boolean {
    const normalize = (file: string): string => {
        let resolved = path.resolve(file);
        try {
            resolved = fs.realpathSync(resolved);
        } catch (_error) { /* The previous machine's path may not exist. */ }
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

/** Preserve generated CMake state when an existing build tree belongs to another location. */
export function backupRelocatedCMakeCache(project: string, binaryDirectory: string): CMakeCacheBackup | undefined {
    const cacheFile = path.join(binaryDirectory, 'CMakeCache.txt');
    if (!fs.existsSync(cacheFile)) { return undefined; }
    const content = fs.readFileSync(cacheFile, 'utf8');
    const entry = (key: string): string => new RegExp(`^${key}:[^=\\r\\n]*=([^\\r\\n]*)`, 'm').exec(content)?.[1] || '';
    const previousProject = entry('CMAKE_HOME_DIRECTORY');
    const previousBuildDirectory = entry('CMAKE_CACHEFILE_DIR');
    const projectMoved = previousProject && !sameLocation(previousProject, project);
    const buildMoved = previousBuildDirectory && !sameLocation(previousBuildDirectory, binaryDirectory);
    if (!projectMoved && !buildMoved) { return undefined; }

    const directory = fs.mkdtempSync(path.join(binaryDirectory, '.rm-debug-cmake-cache-'));
    const moved: string[] = [];
    try {
        // Compiler detection lives in CMakeFiles; removing only CMakeCache.txt is insufficient.
        for (const name of ['CMakeCache.txt', 'CMakeFiles']) {
            const source = path.join(binaryDirectory, name);
            if (!fs.existsSync(source)) { continue; }
            fs.renameSync(source, path.join(directory, name));
            moved.push(name);
        }
    } catch (error) {
        for (const name of moved.reverse()) {
            fs.renameSync(path.join(directory, name), path.join(binaryDirectory, name));
        }
        fs.rmdirSync(directory);
        throw error;
    }
    return { previousProject, previousBuildDirectory, directory };
}
