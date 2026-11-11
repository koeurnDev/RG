const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');
const { createRendererSecurity } = require('../src/native/renderer-security');

const entry = path.join(process.cwd(), 'fixture~1', 'dist-react', 'index.html');
const security = createRendererSecurity(entry);
const encoded = url.pathToFileURL(entry).href;
assert.equal(security.isTrustedUrl(encoded.replace(/%7E/gi, '~')), true, 'Chromium and Node encode the same tilde path differently');
assert.equal(security.isTrustedUrl(encoded.replace(/~|%7E/gi, '%7e')), true);
assert.equal(security.isTrustedUrl(encoded + '?other=1'), false);
assert.equal(security.isTrustedUrl(encoded.replace(/~|%7E/gi, '%257E')), false, 'literal percent filename is a different file');
assert.equal(security.isTrustedUrl(encoded.replace('index.html', 'other.html')), false);
assert.equal(security.isTrustedUrl(encoded.replace('index.html', '..%2findex.html')), false);

const moduleFixture = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/native/renderer-security.js'), 'utf8'), {
  module: moduleFixture, URL, process: { platform: 'win32' },
  require: name => name === 'node:url' ? {
    pathToFileURL: value => url.pathToFileURL(value, { windows: true }),
    fileURLToPath: value => url.fileURLToPath(value, { windows: true }),
  } : require(name),
});
const windows = moduleFixture.exports.createRendererSecurity('c:\\Fixtures\\APP~1\\app.asar\\dist-react\\index.html');
assert.equal(windows.isTrustedUrl('file:///C:/Fixtures/APP~1/app.asar/dist-react/index.html'), true);
assert.equal(windows.isTrustedUrl('file:///C:/Fixtures/APP%7E1/app.asar/dist-react/index.html'), true);
assert.equal(windows.isTrustedUrl('file:///D:/Fixtures/APP~1/app.asar/dist-react/index.html'), false);
assert.equal(windows.isTrustedUrl('file:///C:/Fixtures/other/app.asar/dist-react/index.html'), false);
assert.equal(windows.isTrustedUrl('file:///C:/Fixtures/APP~1/app.asar/dist-react/index.html?other=1'), false);
console.log('PASS equivalent file URL encodings and Windows drives; other files, queries and encoded separators remain denied');
