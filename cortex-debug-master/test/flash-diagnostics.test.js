const assert = require('assert');
const { analyzeFlashFailure, FlashLog, formatFlashDiagnosis } = require('../out/src/frontend/flash-diagnostics');

const cases = [
    ['Error: unable to find a matching CMSIS-DAP device', 'probe-missing'],
    ['Error: open failed', 'probe-missing'],
    ['Cannot connect to J-Link via USB.', 'probe-missing'],
    ['Error: libusb_open() failed with LIBUSB_ERROR_ACCESS\nError: open failed', 'usb-permission'],
    ['Error: unable to open hid device: Permission denied', 'usb-permission'],
    ['Error: libusb_open() failed with LIBUSB_ERROR_NOT_SUPPORTED', 'usb-driver'],
    ['Error: usb_claim_interface failed with LIBUSB_ERROR_BUSY\nError: open failed', 'probe-busy'],
    ['J-Link is already in use by another application.', 'probe-busy'],
    ['/bin/bash: openocd: command not found', 'tool-missing'],
    ['Error: spawn /missing/bash ENOENT', 'tool-missing'],
    ['/bin/bash: /opt/openocd: Permission denied', 'tool-permission'],
    ['Error: Can\'t find interface/cmsis-dap.cfg', 'scripts'],
    ['Error: invalid command name "adapter"', 'scripts'],
    ['Error: The specified debug interface was not found (cmsis-dap)', 'scripts'],
    ['Open On-Chip Debugger 0.11.0\nError: something went wrong', 'openocd-version'],
    ['VTref = 0.000V', 'target-power'],
    ['Error connecting to target.', 'target-connection'],
    ['Error: init mode failed (unable to connect to the target)', 'target-connection'],
    ['Error: UNEXPECTED idcode: 0x12345', 'target-connection'],
    ['Error: flash memory is write protected\nError: programming failed', 'flash-protection'],
    ['Error: Readout protection is enabled', 'flash-protection'],
    ['Info: readout protection disabled\nInfo: device unlocked\nError: verification failed', 'flash-verify'],
    ['Error: Verification failed at address 0x08000000', 'flash-verify'],
    ['Error: programming failed', 'flash-verify'],
    ['', 'unknown'],
    ['Open On-Chip Debugger 0.12.0\nError: unrecognized failure', 'unknown'],
    ['Open On-Chip Debugger 1.0.0\nError: unrecognized failure', 'unknown'],
    ['Error: could not open file firmware.elf', 'unknown']
];
for (const [log, expected] of cases) {
    const diagnoses = analyzeFlashFailure(log, 'linux');
    assert.strictEqual(diagnoses[0].id, expected, log);
    assert(diagnoses[0].steps.length && diagnoses[0].evidence);
    if (expected === 'usb-permission' || expected === 'probe-busy') {
        assert(!diagnoses.some((item) => item.id === 'probe-missing'), 'specific USB errors should suppress the generic probe suggestion');
    }
}
const windows = analyzeFlashFailure('libusb_open() failed with LIBUSB_ERROR_ACCESS', 'win32');
assert(windows[0].steps.join('').includes('驱动'));
assert(!windows[0].steps.join('').includes('udev'));
const linux = analyzeFlashFailure('libusb_open() failed with LIBUSB_ERROR_ACCESS', 'linux');
assert(linux[0].steps.join('').includes('udev'));
assert(formatFlashDiagnosis(linux).includes('日志依据：libusb_open()'));
assert(!analyzeFlashFailure('Error: LIBUSB_ERROR_IO').some((item) => item.id === 'usb-permission'));
assert.strictEqual(analyzeFlashFailure('\x1b[31mError: LIBUSB_ERROR_ACCESS\x1b[0m')[0].evidence, 'Error: LIBUSB_ERROR_ACCESS');

const capture = new FlashLog();
capture.append('Open On-Chip Debugger 0.11.0\n');
capture.append('x'.repeat(200000));
capture.append('\nError: unable to find a matching CMSIS-');
capture.append('DAP device');
assert(capture.text.length < 132000, 'capture must stay bounded');
assert(capture.text.startsWith('Open On-Chip Debugger'));
assert(capture.text.endsWith('CMSIS-DAP device'));
assert.deepStrictEqual(analyzeFlashFailure(capture.text).map((item) => item.id), ['probe-missing', 'openocd-version']);
assert.strictEqual(analyzeFlashFailure(new FlashLog().text)[0].id, 'unknown', 'a new invocation must not retain earlier failures');
console.log(`Flash diagnostics: ${cases.length} log fixtures, platform guidance, ANSI cleanup, bounded capture and chunk boundaries passed.`);
