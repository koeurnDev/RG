import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../mediaSourcesModel.mjs';
const custom = { id: 'custom:550e8400-e29b-41d4-a716-446655440000', label: '测试源', custom: true };

test('source registry accepts named custom sources and filters disabled or malformed entries', () => {
  assert.equal(typeof model.normalizeMediaSources, 'function');
  const result = model.normalizeMediaSources([{ id: 'hongguo', label: '红果短剧' }, custom, custom,
    { ...custom, id: 'custom:bad' }, { ...custom, id: 'custom:650e8400-e29b-41d4-a716-446655440000', enabled: false }]);
  assert.deepEqual(result.map(item => item.id), ['hongguo', custom.id]);
  assert.equal(model.mediaSourceLabel(`${custom.id}:123`, result), '测试源');
  assert.equal(model.mediaSourceLabel('custom:750e8400-e29b-41d4-a716-446655440000:1', result), '自定义源（未启用或已移除）');
});

test('shared source loading coalesces consumers and drops responses from older refreshes', async () => {
  const finish = [];
  const store = model.createMediaSourcesStore(() => new Promise(resolve => finish.push(resolve)));
  const first = store.refresh();
  const joined = store.refresh();
  assert.equal(finish.length, 1);
  const revision = store.getSnapshot().revision;
  const latest = store.refresh(true);
  assert.equal(finish.length, 2);
  assert.ok(store.getSnapshot().revision > revision);
  finish[1]({ success: true, sources: [custom] });
  await latest;
  finish[0]({ success: true, sources: [{ id: 'hema', label: '河马' }] });
  await Promise.all([first, joined]);
  assert.deepEqual(store.getSnapshot().sources, [custom]);
});

test('failed registry refresh surfaces an error without erasing the last working list', async () => {
  let fail = false;
  const store = model.createMediaSourcesStore(async () => fail ? { success: false, error: '不可用' } : { success: true, sources: [custom] });
  await store.refresh(); fail = true; await store.refresh(true);
  assert.deepEqual(store.getSnapshot().sources, [custom]);
  assert.equal(store.getSnapshot().error, '不可用');
});
