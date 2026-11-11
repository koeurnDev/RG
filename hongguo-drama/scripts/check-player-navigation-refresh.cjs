// In-memory component checks only; no real playback, network or user files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { mount } = require('./check-player-resume.cjs');
const tick = async ui => { await [...ui.timers.values()].find(t => t.delay === 2000)?.fn(); await ui.flush(); };
const picker = ui => ui.find(n => n.props.className?.includes('series-picker-btn'));

(async () => {
  let failures = 0;
  const test = async (name, run) => { try { await run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); } };
  await test('leaving pauses and returning preserves the selected source and second', async () => {
    const ui = mount({ local: true });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 29;
      ui.props.active = false; await ui.flush();
      assert.equal(ui.media.paused, true, 'leaving must pause');
      ui.props.active = true; await ui.flush();
      assert.equal(ui.media.paused, true, 'returning must await explicit play');
      assert.equal(ui.media.currentTime, 29);
      await ui.media.play(); assert.equal(ui.media.paused, false);
    } finally { ui.unmount(); }
  });
  await test('late online prepare cannot autoplay after a navigation roundtrip', async () => {
    let finish;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: () => new Promise(resolve => { finish = resolve; }) });
    try {
      await ui.flush(); ui.props.active = false; await ui.flush(); ui.props.active = true; await ui.flush();
      finish({ success: true, url: 'hongguo-stream://ready' }); await ui.flush(); ui.metadata();
      assert.equal(ui.media.paused, true, 'late prepare must remain paused');
    } finally { ui.unmount(); }
  });
  await test('late manual retry cannot autoplay after a navigation roundtrip', async () => {
    let finish, delay = false;
    const detail = { success: true, data: { series_id: 'A', episodes: [{ vid: 'v1', vid_index: 1, status: 'completed', fileUrl: 'file:///one.mp4' }] } };
    const ui = mount({ local: true, apiOverrides: {
      getSeriesEpisodes: async () => delay ? new Promise(resolve => { finish = resolve; }) : detail,
    } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 19; ui.error(1); await ui.flush();
      delay = true;
      const pending = ui.button('重试本集').props.onClick();
      ui.props.active = false; await ui.flush(); ui.props.active = true; await ui.flush();
      const plays = ui.mediaCalls.play;
      finish(detail); await pending; await ui.flush(); ui.metadata();
      assert.equal(ui.media.paused, true, 'a retry revoked by leaving must not autoplay');
      assert.equal(ui.mediaCalls.play, plays);
      delay = false; await ui.button('重试本集').props.onClick(); await ui.flush(); ui.metadata();
      assert.equal(ui.media.paused, false, 'a fresh explicit retry must still play');
      assert.equal(ui.media.currentTime, 19);
    } finally { ui.unmount(); }
  });
  await test('late library initialization retains revoked autoplay intent', async () => {
    let finish, calls = 0;
    const ui = mount({ local: true, apiOverrides: {
      getSeriesList: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([{ series_id: 'A' }]),
    } });
    try {
      await ui.flush(); ui.props.active = false; await ui.flush();
      finish([{ series_id: 'A' }]); await ui.flush(); ui.props.active = true; await ui.flush(); ui.metadata();
      assert.equal(ui.media.paused, true);
    } finally { ui.unmount(); }
  });
  await test('late manual download acknowledgement cannot restore waiting after leaving', async () => {
    let finish;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
      downloadSingleEpisode: () => new Promise(resolve => { finish = resolve; }),
    } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 31;
      const pending = ui.find(n => n.props['aria-label'] === '第 1 集').props.onDoubleClick();
      ui.props.active = false; await ui.flush(); ui.props.active = true; await ui.flush();
      finish({ success: true, count: 1 }); await pending; await ui.flush();
      assert.equal(ui.button('取消等待'), undefined); assert.equal(ui.media.paused, true); assert.equal(ui.media.currentTime, 31);
    } finally { ui.unmount(); }
  });
  await test('pending downloads scan only after state events and progress stays lightweight', async () => {
    let scans = 0, status = 'pending';
    const listeners = new Map();
    const ui = mount({ apiOverrides: {
      ...Object.fromEntries(['onDownloadProgress', 'onDownloadCompleted', 'onDownloadQueueChanged'].map(name => [name, fn => { listeners.set(name, fn); return () => listeners.delete(name); }])),
      getSeriesEpisodes: async () => { scans++; return { success: true, data: { series_id: 'A', episodes: [{ vid_index: 1, vid: 'v1', taskId: 't1', status, ...(status === 'completed' ? { fileUrl: 'file:///one.mp4' } : {}) }] } }; },
    } });
    try {
      await ui.flush(); await tick(ui); const baseline = scans;
      await tick(ui); await tick(ui); assert.equal(scans, baseline, 'pending tasks must not trigger repeated scans');
      listeners.get('onDownloadProgress')?.({ id: 't1', progress: 45 }); await tick(ui);
      assert.equal(scans, baseline, 'progress must not scan');
      status = 'completed'; listeners.get('onDownloadCompleted')?.({ id: 't1' }); await tick(ui);
      assert.equal(scans, baseline + 1, 'completion must revalidate local files');
    } finally { ui.unmount(); }
  });
  await test('library return refreshes new titles without resetting playback and storage is lazy', async () => {
    let storageReads = 0, list = [{ series_id: 'A' }], completed;
    const ui = mount({ local: true, apiOverrides: {
      getSeriesList: async () => list,
      onDownloadCompleted: fn => { completed = fn; return () => {}; },
      getStorageUsage: async () => { storageReads++; return { success: true, series: [], totalFiles: 0, totalBytes: 0 }; },
    } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 37;
      ui.props.active = false; await ui.flush(); list = [...list, { series_id: 'B' }]; completed?.({ id: 'other' }); await ui.flush();
      assert.equal(storageReads, 1, 'hidden completion only invalidates storage');
      ui.props.active = true; await ui.flush(); picker(ui).props.onClick(); await ui.flush();
      assert.ok(ui.find(n => n.props.className?.includes('series-row') && n.props.key === 'B'), 'newly registered title must appear');
      assert.equal(ui.media.currentTime, 37); assert.equal(storageReads, 2);
      picker(ui).props.onClick(); await ui.flush(); picker(ui).props.onClick(); await ui.flush();
      assert.equal(storageReads, 2, 'unchanged panel reopen must reuse storage');
    } finally { ui.unmount(); }
  });
  await test('completion invalidates storage until the next management-panel open', async () => {
    let scans = 0;
    const listeners = new Set();
    const ui = mount({ local: true, apiOverrides: {
      onDownloadCompleted: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      getStorageUsage: async () => { scans++; return { success: true, series: [], totalFiles: 0, totalBytes: 0 }; },
    } });
    try {
      await ui.flush(); for (const fn of listeners) fn({ id: 'download' }); await tick(ui);
      assert.equal(scans, 1, 'completion should not scan all storage during playback');
      picker(ui).props.onClick(); await ui.flush(); assert.equal(scans, 2, 'management must see completed files');
    } finally { ui.unmount(); }
  });
  await test('empty library return selects its first episode without playback', async () => {
    let list = [];
    const ui = mount({ local: true, props: { target: null }, apiOverrides: { getSeriesList: async () => list } });
    try {
      await ui.flush();
      ui.props.active = false; await ui.flush(); list = [{ series_id: 'A' }]; ui.props.active = true; await ui.flush();
      assert.ok(ui.find(n => n.props['aria-label'] === '第 1 集'));
      assert.equal(ui.find(n => n.type === 'video').props.src, undefined);
      assert.equal(ui.button('恢复已移除'), undefined);
    } finally { ui.unmount(); }
  });
  await test('storage recovery event clears the displayed failure', async () => {
    const source = fs.readFileSync(require.resolve('../src/App.jsx'), 'utf8');
    const effect = source.match(/useEffect\(\(\) => window\.electronAPI\.onStorageError\?\.\([\s\S]*?\), \[\]\);/)[0];
    let receive, displayed;
    vm.runInNewContext(effect, { useEffect: fn => fn(), setStorageError: value => { displayed = value; }, window: { electronAPI: { onStorageError: fn => { receive = fn; } } } });
    receive({ error: '模拟保存失败' }); assert.equal(displayed, '模拟保存失败');
    receive(null); assert.equal(displayed, '');
  });
  process.exitCode = failures ? 1 : 0;
})();
