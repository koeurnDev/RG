const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
let handler, mode = 'direct';
const calls = [];
const context = {
  ipcMain: { handle: (_name, fn) => { handler = fn; } },
  proxyStartupFallback: false,
  getCurrentSettings: () => ({}), resolveProxyConfig: () => ({ mode }),
  require: name => ({ browseList: async options => { calls.push({ name, options }); return { success: true, results: [] }; } }),
};
vm.runInNewContext(source.slice(source.indexOf("ipcMain.handle('browse-list'"), source.indexOf('const normalizeSearchTitle')), context);
(async () => {
  await handler({}, { source: 'hongguo', category: 'hot-ai-drama' });
  assert.equal(calls.at(-1).name, './src/native/hongguo-app-catalog', 'Hongguo defaults to the fast App catalog');
  await handler({}, { source: 'hongguo', catalogChannel: 'web' });
  assert.equal(calls.at(-1).name, './src/native/catalog', 'website remains explicitly available');
  assert.equal(calls.at(-1).options.allowTrustedDns, true);
  mode = 'custom';
  await handler({}, { source: 'hongguo', catalogChannel: 'web', allowTrustedDns: true });
  assert.equal(calls.at(-1).options.allowTrustedDns, false, 'renderer cannot bypass selected proxy');
  await handler({}, { source: 'hema', catalogChannel: 'app' });
  assert.equal(calls.at(-1).name, './src/native/hema');
  const before = calls.length;
  assert.equal((await handler({}, { source: 'hongguo', catalogChannel: 'unknown' })).success, false);
  context.proxyStartupFallback = true;
  assert.equal((await handler({}, { source: 'hongguo', catalogChannel: 'app' })).success, false);
  assert.equal(calls.length, before, 'invalid channel and failed proxy startup must not issue requests');
  console.log('PASS catalog routing: App default, explicit website, source isolation and proxy guard');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
