// Real Player deletion feedback with isolated media/API fixtures; no network or files.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mount } = require('./check-player-resume.cjs');

for (const success of [true, false]) test(`delete-all reports running merges skipped alongside success=${success}`, async () => {
  const player = mount({ local: true, apiOverrides: {
    getStorageUsage: async () => ({ success: true, series: [{ series_id: 'A', files: 1, bytes: 1024 }], totalFiles: 1, totalBytes: 1024 }),
    deleteAllDownloaded: async () => ({ success, count: 0, freed: 0, failed: success ? 0 : 1, skipped: 1,
      warning: '1 部剧正在合并，已跳过', error: success ? undefined : '文件占用' }),
  } });
  try {
    await player.flush(); player.button('切换剧集').props.onClick(); await player.flush();
    player.button('删除全部已下载').props.onClick(); await player.flush();
    await player.button('全部删除').props.onClick(); await player.flush();
    const toast = player.find(node => node.props.className === 'dm-toast dm-toast-success')?.children.join('');
    assert.match(toast, /1 部剧正在合并，已跳过/);
    assert.match(toast, /已删除 0 个文件/);
    if (!success) assert.match(toast, /文件占用/);
  } finally { player.unmount(); }
});
