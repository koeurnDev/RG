const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
const startup = source.slice(source.indexOf('if (IS_PREVIEW) {'), source.indexOf('// Windows 便携版'));
for (const platformPath of [path.posix, path.win32]) for (const explicit of [true, false]) {
  const calls = [];
  vm.runInNewContext(startup, {
    IS_PREVIEW: true,
    path: platformPath,
    app: {
      setName: () => {},
      getPath: () => '/temporary/app-data',
      setPath: (...args) => calls.push(args),
      requestSingleInstanceLock: () => true,
      quit: () => {},
      on: () => {},
      commandLine: { hasSwitch: name => { assert.equal(name, 'user-data-dir'); return explicit; } },
    },
  });
  assert.deepEqual(calls, explicit ? [] : [['userData', platformPath.join('/temporary/app-data', 'hongguo-experience-preview')]],
    explicit ? 'explicit user-data-dir must not be overwritten' : 'preview default directory must remain available');
}
console.log('preview startup: explicit directory preserved; default directory retained');
