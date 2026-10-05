const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const binaryModules = path.join(root, 'binary_modules');
const source = path.join(binaryModules, 'node_modules');
const destination = path.join(root, 'dist', 'node_modules');
childProcess.execSync('npm ci --omit=dev', {
    cwd: binaryModules,
    stdio: 'inherit'
});
// Rebuilding on another OS must not leave the previous platform's bindings behind.
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true, force: true });
const { createRequire } = require('module');
const packagedRequire = createRequire(path.join(root, 'dist', 'extension.js'));
packagedRequire('serialport');
packagedRequire('usb');
console.log(`Native modules verified for ${process.platform}-${process.arch}`);
