// Fixture-only library intent regression. No real media, network or user data.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');
(async () => {
  for (const local of [false, true]) {
    const ui = mount({ local, saved: { vid_index: 2, currentTime: 99 }, props: { target: null } });
    await ui.flush();
    assert.equal(ui.prepares.length, 0, 'opening library must not prepare old streams');
    assert.equal(ui.find(n => n.type === 'video').props.src, undefined, 'opening library must not attach local media');
    assert.equal(ui.mediaCalls.play, 0);
    ui.button('播放本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.media.paused, false, 'explicit play still starts');
    ui.episode(1); await ui.flush(); ui.metadata();
    assert.equal(ui.media.paused, false, 'explicit episode selection still starts');
    ui.unmount();
  }
  const ui = mount({ props: { target: null, onNavigate() {} } }); await ui.flush();
  const panel = () => ui.find(n => n.props.id === 'player-management');
  assert.equal(panel().props.hidden, false, 'download actions remain visible below episode selection');
  assert.ok(ui.button('下载未完成集')); assert.ok(ui.button('合并导出全集'));
  let scrolled;
  panel().props.ref.current = { scrollIntoView: options => { scrolled = options; } };
  ui.button('下载管理').props.onClick();
  for (const timer of ui.timers.values()) if (timer.delay === 0) timer.fn();
  assert.equal(scrolled?.block, 'center', 'download shortcut scrolls to this page download tools');

  for (const [label, key, next] of [['缓存后续 2 集', 'cache_next_episode', false], ['兼容模式', 'compat_mode', false]]) {
    assert.equal(ui.button(label).props['aria-pressed'], true);
    await ui.button(label).props.onClick(); await ui.flush();
    assert.equal(ui.button(label).props['aria-pressed'], next);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.settingsSaved.at(-1))), { [key]: next }, 'save only the changed setting');
  }
  const beforeDelete = ui.settingsSaved.length;
  ui.button('看完自动删').props.onClick(); await ui.flush();
  assert.equal(ui.settingsSaved.length, beforeDelete, 'automatic file deletion requires confirmation');
  await ui.button('开启自动删除').props.onClick(); await ui.flush();
  assert.equal(ui.button('看完自动删').props['aria-pressed'], true);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.settingsSaved.at(-1))), { auto_delete_watched: true });
  ui.props.portrait = true; await ui.flush();
  assert.equal(panel().props.hidden, false, 'portrait episode panel retains download actions');
  ui.props.actionsHidden = true; await ui.flush(); assert.equal(panel().props.hidden, true);
  ui.unmount();
  const failed = mount({ apiOverrides: { saveSettings: async () => ({ success: false, error: 'disk full' }) } });
  await failed.flush(); await failed.button('兼容模式').props.onClick(); await failed.flush();
  assert.equal(failed.button('兼容模式').props['aria-pressed'], true, 'failed save must not show the new state');
  assert.ok(failed.find(n => n.props.className?.includes('dm-toast'))); failed.unmount();
  for (const local of [false, true]) for (const autoNext of [false, true]) {
    const cleaned = [];
    const playing = mount({ local, settings: { auto_delete_watched: true },
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
        cleanupWatchedEpisode: async (...args) => { cleaned.push(args); return { success: true, count: 1, freed: 20 }; },
      } });
    await playing.flush(); playing.metadata(); playing.media.currentTime = 100;
    if (!autoNext) { playing.button('连播').props.onClick(); await playing.flush(); }
    const savedBeforeEnd = playing.saves.length;
    playing.find(n => n.type === 'video').props.onEnded(); await playing.flush();
    assert.deepEqual(cleaned, [['A', 1]], 'online and local ended both invoke the unified cleanup');
    assert.ok(!playing.saves.slice(savedBeforeEnd).some(args => args[1] === 1 && args[2] === 0), 'cleanup must not erase the finished position');
    if (autoNext) {
      playing.metadata(); assert.equal(playing.media.paused, false, 'cleanup preserves auto-next');
      assert.ok(playing.find(n => n.type === 'video').props.src);
    } else assert.equal(playing.find(n => n.type === 'video').props.src, undefined);
    playing.unmount();
  }
  let finishRelease, cleanupCalls = 0;
  const releasing = mount({ settings: { auto_delete_watched: true, cache_next_episode: false },
    props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
      releaseOnlinePlay: () => new Promise(resolve => { finishRelease = resolve; }),
      cleanupWatchedEpisode: async () => { cleanupCalls++; return { success: true, count: 0 }; },
    } });
  await releasing.flush(); releasing.metadata(); releasing.find(n => n.type === 'video').props.onEnded(); await releasing.flush();
  assert.equal(cleanupCalls, 0, 'cleanup waits for backend stream release');
  finishRelease(); await releasing.flush(); assert.equal(cleanupCalls, 1); releasing.unmount();
  const forgotten = [];
  let list = [{ series_id: 'A', series_title: '甲' }, { series_id: 'B', series_title: '乙' }];
  const library = mount({ props: { target: null }, apiOverrides: {
    getSeriesList: async () => list,
    getSeriesEpisodes: async series_id => ({ success: true, data: { series_id, series_title: series_id, episodes: [{ vid_index: 1, vid: series_id, status: 'missing' }] } }),
    forgetSeries: async sid => { forgotten.push(sid); list = list.filter(item => item.series_id !== sid); return { success: true }; },
    deleteSeriesFiles: () => { throw new Error('record removal must never delete files'); },
  } });
  await library.flush(); library.button('切换剧集').props.onClick(); await library.flush();
  library.find(n => n.props['aria-label'] === '永久移除 甲 的剧库记录').props.onClick({ stopPropagation() {} });
  await library.flush(); assert.deepEqual(forgotten, [], 'record removal requires the concrete confirmation');
  await library.button('永久移除').props.onClick(); await library.flush();
  assert.deepEqual(forgotten, ['A']); assert.equal(library.prepares.length, 0, 'removing a record must not play its replacement');
  assert.equal(library.button('恢复已移除'), undefined); library.unmount();
  const queued = [];
  const rangeEpisodes = Array.from({ length: 20 }, (_, i) => ({ vid_index: i + 1, vid: `v${i + 1}`, status: i === 10 ? 'completed' : 'missing', locked: i === 9 }));
  const ranges = mount({ episodeCount: 20, props: { target: { seriesId: 'A', vidIndex: 8, autoplay: false, ts: 1 } }, settings: { download_quality: '720p' }, apiOverrides: {
    getSeriesEpisodes: async () => ({ success: true, data: { series_id: 'A', series_title: '测试剧', episodes: rangeEpisodes } }),
    downloadSingleEpisode: async (...args) => { queued.push(args); return args[1] === 12 ? { success: false, error: '测试失败' } : { success: true, count: 1 }; },
  } });
  await ranges.flush();
  assert.ok(ranges.button('下载本集'), 'current episode download button exists');
  await ranges.button('下载本集').props.onClick(); await ranges.flush();
  assert.deepEqual(queued, [['A', 8, '720p']]); queued.length = 0;
  await ranges.button('下载后5集').props.onClick(); await ranges.flush();
  assert.deepEqual(queued.map(args => args[1]), [9, 12, 13], 'next five excludes current, locked and completed, without extending the range');
  const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') || '';
  assert.match(text(ranges.find(n => n.props.className === 'dm-toast dm-toast-success')), /2 集提交成功，1 集失败/);
  queued.length = 0;
  await ranges.button('下载后10集').props.onClick(); await ranges.flush();
  assert.deepEqual(queued.map(args => args[1]), [9, 12, 13, 14, 15, 16, 17, 18]);
  assert.ok(queued.every(args => args[0] === 'A' && args[2] === '720p'));
  ranges.episode(18); await ranges.flush(); queued.length = 0;
  await ranges.button('下载后5集').props.onClick(); await ranges.flush();
  assert.deepEqual(queued.map(args => args[1]), [19, 20], 'range ends at the final episode');
  ranges.episode(20); await ranges.flush();
  assert.equal(ranges.button('下载后10集').props.disabled, true);
  ranges.unmount();
  console.log('PASS library waits for intent; explicit playback, management, cleanup and permanent record removal');
})().catch(error => { console.error(error); process.exitCode = 1; });
