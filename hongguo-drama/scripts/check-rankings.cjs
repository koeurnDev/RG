const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(__dirname, 'fixtures/rankings', `${name}.html`), 'utf8');

async function main() {
  const calls = [];
  let response;
  const context = { module: { exports: {} }, require: name => name === 'axios' ? { get: async (url, options) => {
    calls.push({ url, options });
    return { data: response ?? read(url.split('/rank/')[1].replace('?page=2', '-page-2')) };
  } } : name === './web-media-guard' ? { webMediaRequestOptions: () => ({}) } : require(name), AbortController, setTimeout, clearTimeout, URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/native/catalog.js'), 'utf8'), context);
  const { browseList } = context.module.exports;
  for (const [category, id, title, heat] of [
    ['hot-drama', '7691228619774905368', '聚宝仙盆之杂灵根才是真BOSS第十三季', '7173万热度'],
    ['hot-real-drama', '7686713195246930968', '首辅娇娘', '6772万热度'],
    ['hot-comic-drama', '7691228619774905368', '聚宝仙盆之杂灵根才是真BOSS第十三季', '7173万热度'],
    ['hot-ai-drama', '7692043430955863102', '反向拿捏：和闺蜜穿七零带着婆婆一起离', null],
  ]) {
    const data = await browseList({ category });
    assert.equal(data.success, true, `${category}: ${data.error}`);
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].series_id, id);
    assert.equal(data.results[0].series_title, title);
    assert.equal(data.results[0].rank, 1);
    assert.match(data.results[0].heat, /热度$/);
    if (heat) assert.equal(data.results[0].heat, heat);
    if (category === 'hot-real-drama') assert(data.results[0].episode_count > 24, 'streamed JSON must supply full episode metadata');
    assert.equal(data.results[0].url, `https://hongguoduanju.com/detail?series_id=${id}`);
    assert.equal(data.totalPages, 5);
    assert.equal(data.page, 1);
    assert.equal(data.genres.length, 0);
  }
  const second = await browseList({ category: 'hot-drama', page: 2 });
  assert.equal(second.page, 2);
  assert.equal(second.results[0].rank, 21, 'second-page ranks must remain absolute');
  assert.equal(second.results[0].series_id, '7693492249157438489');
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/rank/hot-drama?page=2');
  await browseList({ category: 'hot-drama', page: 2 });
  assert.equal(calls.length, 5, 'ranking pages use the existing cache');
  response = '<html><script>throw Error("remote scripts must never execute")</script></html>';
  const bad = await browseList({ category: 'hot-drama', forceRefresh: true });
  assert.equal(bad.success, false);
  assert.match(bad.error, /榜单/);
  assert.equal(bad.sourceUrl, 'https://hongguoduanju.com/rank/hot-drama');
  response = read('hot-drama').replace(/pc-[A-Za-z][\w-]*/g, 'changed-style');
  const renamed = await browseList({ category: 'hot-drama', forceRefresh: true });
  assert.equal(renamed.success, true, 'semantic parsing must survive CSS hash changes');
  assert.equal(renamed.results[0].rank, 1);
  assert.equal(renamed.results[0].heat, '7173万热度');
  const invalid = await browseList({ category: 'hot-drama', genre: '../../outside' });
  assert.equal(invalid.success, false);
  console.log('PASS rankings: four live-source fixtures, streamed JSON and semantic HTML, rank/heat, page 2, cache, retry and malformed data');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
