const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const source = path.resolve(__dirname, '../../main.js');
const req = createRequire(source);
const sid = '7240000000000000001', vid = '7503780574541122622';
const payload = extra => ({ seriesId: sid, seriesTitle: '测试剧', episodes: [{ vid, vid_index: 1 }],
  export: { comments: true }, requestId: 'request-one', ...extra });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture(t, exporter = async () => ({ comments: { ok: 1, fail: 0, skipped: 0, partial: 0 } })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = {}, events = [], calls = [], app = new EventEmitter();
  let settings = { root }, failSave = false;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const store = { getSettings: () => settings, saveTasks() { if (failSave) throw new Error('disk full'); }, saveSettings: value => { settings = value; } };
  const context = vm.createContext({ require: name => name === 'electron'
    ? { app, ipcMain: { handle: (key, fn) => { handlers[key] = fn; } }, protocol: { registerSchemesAsPrivileged() {} } }
    : name === './src/store' ? store
    : name === './src/native/text-export' ? { exportSeriesText: options => { calls.push(options); return exporter(options); } }
    : req(name), __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('../../scripts/fixtures/trusted-ipc.cjs')(context, handlers);
  context.captureEvent = (channel, data) => events.push({ channel, data });
  const run = code => vm.runInContext(code, context);
  run('sendToRenderer = captureEvent; pumpQueue = () => {};');
  return { root, handlers, calls, events, run, context, settings: () => settings,
    setSettings: value => { settings = { ...settings, ...value }; }, failSave: () => { failSave = true; } };
}

test('text export follows an existing task destination after settings change', async t => {
  const h = fixture(t);
  const oldFile = path.join(h.root, 'old', 'original-name.mp4');
  h.context.existingTask = { id: 'old', type: 'hongguo', status: 'pending', downloadQuality: 'auto', savePath: oldFile,
    customDir: path.dirname(oldFile), hongguoInfo: { series_id: sid, vid, vid_index: 1 } };
  h.run('downloadTasks = [existingTask]; downloadQueue = [existingTask];');
  h.setSettings({ root: path.join(h.root, 'new'), name_format: '剧名 集数 标题' });
  const result = await h.handlers['hongguo-download-batch']({}, payload());
  await flush();
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].episodes[0].savePath, oldFile);
  assert.equal(path.dirname(h.calls[0].reviewsPath), path.dirname(oldFile));
});

test('text export uses repaired task paths and ignores renderer supplied destinations', async t => {
  const h = fixture(t);
  const shared = path.join(h.root, 'collision.mp4');
  h.context.tasks = [vid, '7503780574541122623'].map((id, i) => ({ id, type: 'hongguo', status: 'stopped',
    savePath: shared, customDir: h.root, hongguoInfo: { series_id: sid, series_title: '测试剧', vid: id, vid_index: i + 1 } }));
  h.run('downloadTasks = tasks;');
  const result = await h.handlers['hongguo-download-batch']({}, payload({ episodes: [{ vid, vid_index: 1, savePath: '/outside/forged.mp4' }] }));
  await flush();
  assert.equal(result.success, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].episodes[0].savePath, h.run('downloadTasks[0].savePath'));
  assert.notEqual(h.calls[0].episodes[0].savePath, shared);
  assert.notEqual(h.calls[0].episodes[0].savePath, '/outside/forged.mp4');
});

test('text export runs in background and returns request identity and submitted kinds', async t => {
  let finish;
  const h = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const input = payload();
  const result = await h.handlers['hongguo-download-batch']({}, input);
  assert.equal(result.success, true);
  assert.equal(result.exportRequested, true);
  assert.equal(result.requestId, input.requestId);
  assert.equal(h.events.some(event => event.channel === 'text-export-done'), false);
  input.export.comments = false;
  finish({ comments: { ok: 1, fail: 0, skipped: 0, partial: 0 } });
  await flush();
  const done = h.events.find(event => event.channel === 'text-export-done').data;
  assert.equal(done.requestId, 'request-one');
  assert.equal(done.seriesId, sid);
  assert.equal(done.kinds.comments, true);
});

test('text export failure is reported without failing the video submission', async t => {
  const h = fixture(t, async () => { throw new Error('export unavailable'); });
  const result = await h.handlers['hongguo-download-batch']({}, payload());
  await flush();
  assert.equal(result.success, true);
  const done = h.events.find(event => event.channel === 'text-export-done').data;
  assert.equal(done.failed, true);
  assert.match(done.error, /export unavailable/);
  assert.equal(done.requestId, 'request-one');
});

test('failed queue persistence and non-Hongguo sources do not start text exports', async t => {
  const h = fixture(t);
  h.failSave();
  assert.equal((await h.handlers['hongguo-download-batch']({}, payload())).success, false);
  await flush();
  assert.equal(h.calls.length, 0);
  const other = fixture(t);
  other.context.thirdPartyEpisode = { vid: 'xifan:test:1', vid_index: 1 };
  other.run('hongguo.fetchEpisodeList = async () => ({ episodes: [thirdPartyEpisode] });');
  const result = await other.handlers['hongguo-download-batch']({}, payload({ seriesId: 'xifan:test', episodes: [other.context.thirdPartyEpisode] }));
  await flush();
  assert.equal(result.success, true);
  assert.equal(result.exportRequested, false);
  assert.equal(other.calls.length, 0);
});

test('text export preferences are editable and reduced to known boolean fields', t => {
  const h = fixture(t);
  h.context.incomingSettings = { export_text: { comments: true, danmaku: 'yes', reviews: false, injected: true } };
  const settings = h.run('applyEditableSettings(getCurrentSettings(), incomingSettings)');
  assert.deepEqual(JSON.parse(JSON.stringify(settings.export_text)), { danmaku: false, comments: true, reviews: false });
});

test('preload text export subscription removes its own listener', () => {
  let api;
  const emitter = new EventEmitter();
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } }, ipcRenderer: emitter }),
  });
  assert.equal(typeof api.onTextExportDone, 'function');
  let calls = 0;
  const off = api.onTextExportDone(data => { assert.equal(data.requestId, 'one'); calls++; });
  emitter.emit('text-export-done', {}, { requestId: 'one' });
  off();
  emitter.emit('text-export-done', {}, { requestId: 'one' });
  assert.equal(calls, 1);
});
