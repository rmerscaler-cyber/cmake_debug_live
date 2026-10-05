import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export function toolName(name: string): string {
    if (process.platform === 'win32') { return name + '.exe'; }
    if (name === 'JLink') { return 'JLinkExe'; }
    if (name === 'JLinkGDBServerCL') { return 'JLinkGDBServerCLExe'; }
    return name;
}

export function platformSetting(): string {
    return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

export function normalizedToolPath(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function executableFile(value: string): boolean {
    if (!existingFile(value)) { return false; }
    try {
        fs.accessSync(value, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
    } catch (_error) { return false; }
}

export function configuredBash(settings: { get<T>(key: string, fallback: T): T }): string {
    const configured = settings.get<string>(process.platform === 'win32' ? 'gitBashPath' : 'bashPath', '');
    return executableFile(configured) ? configured : findBash();
}

export function armToolchainDirectory(gcc: string, gdb: string): string {
    // gdb-multiarch may live in /usr/bin while ARM binutils live in a separate toolchain.
    return path.dirname(executableFile(gcc) ? gcc : gdb);
}

export function bashPath(value: string): string {
    if (process.platform !== 'win32') { return value; }
    return value.replace(/^([a-zA-Z]):[\\/]/, (_match, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

export function bashQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function existingFile(value: string): boolean {
    return Boolean(value) && fs.existsSync(value) && fs.statSync(value).isFile();
}

export function existingDirectory(value: string): boolean {
    return Boolean(value) && fs.existsSync(value) && fs.statSync(value).isDirectory();
}

export function uniqueFiles(values: string[]): string[] {
    const seen = new Set<string>();
    return values.map((value) => value.trim().replace(/^"|"$/g, '')).filter((value) => {
        if (!executableFile(value)) { return false; }
        const key = normalizedToolPath(value);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

export function whereFiles(name: string): string[] {
    if (process.platform !== 'win32') { return []; }
    try {
        return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
            .split(/\r?\n/);
    } catch (_error) { return []; }
}

export function findBash(): string {
    if (process.platform !== 'win32') {
        return uniqueFiles([...(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'bash')),
            '/bin/bash', '/usr/bin/bash'])[0] || '';
    }
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const candidates = [
        ...whereFiles('git.exe').map((git) => path.resolve(path.dirname(git), '..', 'bin', 'bash.exe')),
        ...pathDirs.map((dir) => path.join(dir, 'bash.exe')),
        ...pathDirs.map((dir) => path.resolve(dir, '..', 'bin', 'bash.exe')),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe')
    ];
    return uniqueFiles(candidates)[0] || '';
}

export function executableCandidates(name: string, bash: string): string[] {
    const fromPath = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, name));
    let fromBash: string[] = [];
    if (existingFile(bash)) {
        try {
            const lookup = `type -P -a ${bashQuote(name.replace(/\.exe$/i, ''))}`;
            const command = process.platform === 'win32'
                ? `${lookup} | while IFS= read -r file; do cygpath -w "$file"; done`
                : lookup;
            fromBash = execFileSync(bash, ['-lc', command], {
                encoding: 'utf8', windowsHide: true, timeout: 8000
            }).split(/\r?\n/);
        } catch (_error) { /* Process PATH candidates remain available. */ }
    }
    return uniqueFiles([...fromPath, ...whereFiles(name), ...fromBash]);
}

export function jlinkCandidates(name: string, bash: string): string[] {
    if (process.platform !== 'win32') {
        const roots = ['/opt/SEGGER', '/usr/local/SEGGER', '/Applications/SEGGER'];
        const installed = roots.flatMap((root) => existingDirectory(root)
            ? fs.readdirSync(root).filter((entry) => /^JLink/i.test(entry)).map((entry) => path.join(root, entry, name))
            : []);
        return uniqueFiles([...executableCandidates(name, bash), ...installed]);
    }
    let registered: string[] = [];
    try {
        const registryPaths = [
            'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
        ];
        const registryQuery = [
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            `$keys = @(${registryPaths.map((key) => `'${key}'`).join(', ')})`,
            [
                'Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue',
                'Where-Object { $_.DisplayName -like \'J-Link*\' -and $_.InstallLocation }',
                'Select-Object -ExpandProperty InstallLocation'
            ].join(' | '),
            'exit 0'
        ].join('; ');
        registered = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryQuery], {
            encoding: 'utf8', windowsHide: true, timeout: 8000
        }).split(/\r?\n/).filter(Boolean).map((directory) => path.join(directory.trim(), name));
    } catch (_error) { /* PATH and common installation folders remain available. */ }
    const seggerRoots = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SEGGER'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SEGGER'),
        'C:\\SEGGER'
    ];
    const installed = seggerRoots.flatMap((root) => {
        if (!existingDirectory(root)) { return []; }
        return fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^JLink/i.test(entry.name))
            .map((entry) => path.join(root, entry.name, name));
    });
    return uniqueFiles([...registered, ...executableCandidates(name, bash), ...installed]);
}

export function discoverArmGdb(bash: string, gcc: string, saved: string): string {
    const name = toolName('arm-none-eabi-gdb');
    const besideGcc = gcc ? path.join(path.dirname(gcc), name) : '';
    return uniqueFiles([saved, besideGcc, ...executableCandidates(name, bash),
        ...(process.platform === 'linux' ? executableCandidates('gdb-multiarch', bash) : [])]).find((candidate) => {
        if (process.platform !== 'linux') { return true; }
        try {
            // ARM releases may depend on Python/libncurses versions absent on Ubuntu.
            execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
            return true;
        } catch (_error) { return false; }
    }) || '';
}
