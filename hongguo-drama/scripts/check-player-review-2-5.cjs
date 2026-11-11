// In-memory components only; no network, actual media or file deletion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { mount } = require('./check-player-resume.cjs');
const harness = fs.readFileSync(`${__dirname}/check-download-manager.cjs`, 'utf8').split('\n(async () => {')[0];
const harnessModule = { exports: {} };
vm.runInNewContext(`${harness}\nmodule.exports = { mount, task };`, { module: harnessModule, require, __dirname, console });
const { mount: mountDownloads, task } = harnessModule.exports;
const settingsHarness = fs.readFileSync(`${__dirname}/check-app-update-ui.cjs`, 'utf8').split('\n(async () => {')[0];
const settingsModule = { exports: {} };
vm.runInNewContext(`${settingsHarness}\nmodule.exports = { mount };`, { module: settingsModule, require, __dirname, console });
const mountSettings = api => settingsModule.exports.mount(api, 'Settings');
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';
const visible = (ui, value) => ui.find(node => text(node).includes(value));
const setting = (ui, label) => ui.find(node => node.type === 'label' && text(node).startsWith(label))?.children.find(node => node?.type === 'input');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

(async () => {
  let passed = 0, failed = 0;
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const test = async (name, run) => {
    try { await run(); passed++; }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  };
  for (const rejected of [false, true]) await test(`detail ${rejected ? 'rejection' : 'failure'} offers retry and retains requested episode`, async () => {
    let broken = true;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 2, ts: 1 } }, apiOverrides: {
      getSeriesEpisodes: async () => {
        if (broken) { if (rejected) throw new Error('详情暂不可用'); return { success: false, error: '详情暂不可用' }; }
        return { success: true, data: { series_id: 'A', episodes: [{ vid_index: 2, vid: 'v2', status: 'missing' }] } };
      },
    } });
    try {
      await ui.flush();
      assert.ok(visible(ui, '详情暂不可用'), 'failed detail must be visible');
      assert.ok(ui.button('重试加载'), 'failed detail must offer retry');
      broken = false; await ui.button('重试加载').props.onClick(); await ui.flush();
      assert.equal(ui.prepares.at(-1)?.vidIndex, 2);
      assert.equal(ui.button('重试加载'), undefined);
    } finally { ui.unmount(); }
  });
  for (const [label, key, initial] of [['自动兼容模式', 'compat_mode', true], ['看完自动删除', 'auto_delete_watched', false]]) {
    await test(`${label} updates only after successful persistence`, async () => {
      const pending = defer();
      let persisted = { [key]: initial }, submitted;
      const ui = mountSettings({ getSettings: async () => ({ ...persisted }), saveSettings: async next => {
        submitted = next; const result = await pending.promise;
        if (result.success) persisted = { ...next };
        return result;
      } });
      try {
        await ui.flush(); assert.equal(setting(ui, label).props.checked, initial);
        setting(ui, label).props.onChange({ target: { checked: !initial } }); await ui.flush();
        assert.equal(persisted[key], initial, 'editing the draft must not change the active setting');
        const saving = ui.button('保存当前设置').props.onClick(); await ui.flush();
        assert.equal(submitted[key], !initial); assert.equal(persisted[key], initial, 'pending save must keep the persisted setting');
        assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true);
        pending.resolve({ success: true }); await saving; await ui.flush();
        assert.equal(persisted[key], !initial); assert.equal(setting(ui, label).props.checked, !initial);
        assert.ok(visible(ui, '已保存')); assert.ok(!visible(ui, '有未保存的修改'));
      } finally { pending.resolve({ success: false }); ui.unmount(); }
    });
    for (const rejected of [false, true]) await test(`${label} ${rejected ? 'rejection' : 'failure'} keeps state and explains failure`, async () => {
      let persisted = { [key]: initial }, broken = true;
      const ui = mountSettings({ getSettings: async () => ({ ...persisted }), saveSettings: async next => {
        if (broken) { if (rejected) throw new Error('设置写入失败'); return { success: false, error: '设置写入失败' }; }
        persisted = { ...next }; return { success: true };
      } });
      try {
        await ui.flush(); setting(ui, label).props.onChange({ target: { checked: !initial } }); await ui.flush();
        await ui.button('保存当前设置').props.onClick(); await ui.flush();
        assert.equal(persisted[key], initial, 'failed save must keep the persisted setting');
        assert.equal(setting(ui, label).props.checked, !initial, 'keep the unsaved draft available for retry');
        assert.ok(ui.find(node => node.props.role === 'alert' && text(node).includes('设置写入失败')));
        assert.ok(visible(ui, '有未保存的修改')); assert.ok(!visible(ui, '已保存'));
        assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false);
        broken = false; await ui.button('保存当前设置').props.onClick(); await ui.flush();
        assert.equal(persisted[key], !initial); assert.ok(!visible(ui, '设置写入失败'));
      } finally { ui.unmount(); }
    });
  }
  for (const rejected of [false, true]) await test(`automatic deletion ${rejected ? 'rejection' : 'failure'} is explained while next episode continues`, async () => {
    const before = unhandled.length;
    const cleaned = [];
    const ui = mount({ local: true, settings: { auto_delete_watched: true }, apiOverrides: { cleanupWatchedEpisode: async (...args) => {
      cleaned.push(args);
      if (rejected) throw new Error('文件正在使用'); return { success: false, error: '文件正在使用' };
    } } });
    try {
      await ui.flush(); ui.metadata(); ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
      await new Promise(done => setImmediate(done));
      assert.equal(unhandled.length, before, 'delete must not leave an unhandled rejection');
      assert.deepEqual(cleaned, [['A', 1]], 'cleanup must target only the ended episode');
      assert.ok(visible(ui, '文件正在使用'), 'delete failure must be visible');
      assert.equal(ui.find(node => node.type === 'video').props.src, 'file:///mock-2.mp4');
    } finally { ui.unmount(); }
  });
  for (const status of ['stopped', 'failed', 'pending']) await test(`resume ${status} tasks while another download is active`, async () => {
    let resumed = 0;
    const ui = mountDownloads({ getDownloadTasks: async () => [task(1), task(2, status)],
      getQueueStatus: async () => ({ active: 1, queued: 0, maxConcurrent: 3 }),
      resumeAll: async () => ({ success: true, count: ++resumed }) });
    try {
      await ui.flush(); assert.equal(ui.button('全部开始').props.disabled, false);
      await ui.button('全部开始').props.onClick(); assert.equal(resumed, 1);
    } finally { ui.unmount(); }
  });
  await test('no resumable tasks keeps resume disabled', async () => {
    const ui = mountDownloads({ getDownloadTasks: async () => [task(1), task(2, 'completed')] });
    try { await ui.flush(); assert.equal(ui.button('全部开始').props.disabled, true); }
    finally { ui.unmount(); }
  });
  process.removeListener('unhandledRejection', onUnhandled);
  console.log(`Player review 2.5: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
