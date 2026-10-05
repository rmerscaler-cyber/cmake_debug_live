const assert = require('assert');
const { shouldTraverseLiveChildren } = require('../out/src/frontend/views/live-watch-traversal.js');

assert.strictEqual(shouldTraverseLiveChildren(true, false, true, false), true,
    'monitor-all follows the first pointer target');
assert.strictEqual(shouldTraverseLiveChildren(true, false, true, false, false, 1), false,
    'monitor-all stops before a second pointer hop');
assert.strictEqual(shouldTraverseLiveChildren(true, true, true, false), true,
    'explicit expansion follows a pointer target');
assert.strictEqual(shouldTraverseLiveChildren(true, false, true, true), true,
    'a plot subscription follows its pointer path');
assert.strictEqual(shouldTraverseLiveChildren(false, false, true, false), true,
    'monitor-all traverses embedded structure fields');
assert.strictEqual(shouldTraverseLiveChildren(false, false, false, false), false,
    'collapsed ordinary structures need no child subscription');
assert.strictEqual(shouldTraverseLiveChildren(false, false, true, false, true), false,
    'monitor-all must not ask GDB for children of scalar values');
assert.strictEqual(shouldTraverseLiveChildren(false, true, true, false, true), false,
    'even a restored expanded state must not turn a scalar into a container');
console.log('Live Watch traversal checks passed');
