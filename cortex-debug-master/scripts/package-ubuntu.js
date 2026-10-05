const { spawnSync } = require('child_process');
const path = require('path');
const { version } = require('../package.json');

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Build the Ubuntu VSIX on Linux x64 or arm64 so native USB/serial bindings can be verified.');
}
const root = path.resolve(__dirname, '..');
const target = `linux-${process.arch}`;
const result = spawnSync(process.execPath, [
    // Webpack bundles JS dependencies; prepare-package copies native runtime modules into dist.
    require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--target', target,
    '--out', `rm-debug-${version}-${target}.vsix`
], { cwd: root, stdio: 'inherit' });
if (result.error) { throw result.error; }
process.exit(result.status ?? 1);
