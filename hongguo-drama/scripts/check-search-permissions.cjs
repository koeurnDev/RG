// Isolated window navigation and permission checks; no Electron GUI or network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
async function checkWindows() {
  const windows = [];
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false; this.urls = [];
      this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async script => script === 'cards'
        ? '[{"series_id":"1234567","series_title":"fixture"}]' : '{}';
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadURL(url) { this.urls.push(url); }
  }
  const context = vm.createContext({ BrowserWindow: Window, SEARCH_SITE: 'https://hongguoduanju.com',
    SEARCH_TIMEOUT_MS: 20, SEARCH_UA: '', SNIFFER_JS: 'cards', BROWSE_META_JS: 'meta',
    setTimeout, clearTimeout, URL, console: { log() {}, warn() {} } });
  vm.runInContext(source.slice(source.indexOf('function sourcePageUrl('), source.indexOf('/**\n * 通用卡片')), context);
  vm.runInContext(source.slice(source.indexOf('async function runSniffOnUrl('), source.indexOf('async function runSearchSniff(')), context);
  const visible = context.getSearchWindow(); await visible.loadURL('https://hongguoduanju.com/detail?series_id=1234567');
  assert.equal((await context.runSniffOnUrl('https://hongguoduanju.com/search/fixture', 'Search')).success, true);
  assert.equal(windows.length, 2, 'background search must own another window');
  assert.equal(visible.urls.length, 1, 'background search navigated the visible window');
  const hidden = context.getSearchWindow(true); hidden.loadURL = () => new Promise(() => {});
  const pending = context.runSniffOnUrl('https://hongguoduanju.com/search/stalled', 'Search');
  await visible.loadURL('https://hongguoduanju.com/category/comic');
  await assert.rejects(pending, /超时/);
  assert.equal(visible.destroyed, false, 'timeout destroyed the user window');
  assert.equal(hidden.destroyed, true);
  assert.notEqual(context.getSearchWindow(true), hidden);
}
function checkPermissions() {
  const app = new EventEmitter(), entry = path.join(__dirname, '../dist-react/index.html');
  const url = pathToFileURL(entry).href;
  const main = { webContents: { mainFrame: { url } }, isDestroyed: () => false };
  const context = vm.createContext({ app, mainWindow: main,
    rendererSecurity: require('../src/native/renderer-security').createRendererSecurity(entry) });
  const start = source.indexOf("app.on('web-contents-created'");
  assert.ok(start >= 0, 'permission handlers are missing');
  vm.runInContext(source.slice(start, source.indexOf('if (hasSingleInstanceLock) app.whenReady()', start)), context);
  let request, check;
  app.emit('web-contents-created', {}, { session: {
    setPermissionRequestHandler: fn => request = fn, setPermissionCheckHandler: fn => check = fn,
  } });
  const details = { isMainFrame: true, requestingUrl: url };
  for (const permission of ['media', 'display-capture', 'geolocation', 'notifications', 'unknown']) {
    let allowed; request(main.webContents, permission, value => allowed = value, details);
    assert.equal(allowed, false, permission); assert.equal(check(main.webContents, permission, 'file://', details), false);
  }
  for (const permission of ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write']) {
    let allowed; request(main.webContents, permission, value => allowed = value, details);
    assert.equal(allowed, true, `main needs ${permission}`);
    assert.equal(check(main.webContents, permission, 'file://', details), true);
    for (const [contents, requestDetails] of [
      [main.webContents, { ...details, isMainFrame: false }],
      [main.webContents, { ...details, requestingUrl: 'https://hongguoduanju.com/' }],
      [{ mainFrame: { url } }, details], [null, details], [main.webContents, undefined],
    ]) {
      request(contents, permission, value => allowed = value, requestDetails);
      assert.equal(allowed, false); assert.equal(check(contents, permission, 'file://', requestDetails), false);
    }
  }
}
(async () => {
  let failed = 0;
  for (const [name, run] of [['separate search windows and timeout recovery', checkWindows], ['remote permission denial and trusted fullscreen/clipboard', checkPermissions]]) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  process.exitCode = failed ? 1 : 0;
})();
