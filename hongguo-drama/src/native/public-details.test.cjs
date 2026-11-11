const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { fetchPublicDetails, parsePublicDetails } = require('./public-details');

const SID = '7503745441910017049';
const VID = '7503780574541122622';
const html = (seriesId = SID, vid = '') => {
  const reviews = { total_count: '15536', reviews: Array.from({ length: 1200 }, (_, i) =>
    ({ content: `评${i}`, user_name: `u${i}`, create_time: '123', digg_count: '2', rating: 5 })) };
  return `window._ROUTER_DATA=${JSON.stringify({ loaderData: { detail: {
    seriesDetail: { series_id: seriesId }, vid, seriesSocialInfo: { reviews }, episodeSocialInfo: { reviews },
  } } })};`;
};

test('公开详情默认仍为50条，导出可取1000条，不改字段协议和身份校验', () => {
  const small = parsePublicDetails(html(SID, VID), SID, VID);
  assert.equal(small.reviews.items.length, 50);
  assert.equal(small.episode_reviews.items.length, 50);
  const big = parsePublicDetails(html(SID, VID), SID, VID, { reviewsLimit: 1000 });
  assert.equal(big.reviews.items.length, 1000);
  assert.equal(big.episode_reviews.items.length, 1000);
  assert.equal(big.reviews.total, 15536);
  assert.deepEqual(big.reviews.items[0], { author: 'u0', avatar: '', content: '评0', created_at: 123000, likes: 2, rating: 5 });
  assert.throws(() => parsePublicDetails(html(), '1234567'), /剧集不匹配/);
  assert.throws(() => parsePublicDetails(html(SID, VID), SID, '1234567'), /分集不匹配/);
});

test('50与1000条缓存独立，同上限并发去重，失败后可重新请求', async t => {
  let calls = 0;
  let fail = false;
  t.mock.method(axios, 'get', async url => {
    calls++;
    if (fail) throw new Error('offline');
    return { data: html(new URL(url).searchParams.get('series_id')) };
  });
  const small = await fetchPublicDetails(SID);
  assert.equal(small.reviews.items.length, 50);
  const [a, b] = await Promise.all([
    fetchPublicDetails(SID, '', { reviewsLimit: 1000 }), fetchPublicDetails(SID, '', { reviewsLimit: 1000 }),
  ]);
  assert.equal(a.reviews.items.length, 1000);
  assert.deepEqual(b, a);
  assert.equal(calls, 2);
  assert.equal((await fetchPublicDetails(SID)).reviews.items.length, 50);
  assert.equal(calls, 2);
  const other = '7503745441910017050';
  fail = true;
  assert.equal((await fetchPublicDetails(other, '', { reviewsLimit: 1000 })).success, false);
  fail = false;
  assert.equal((await fetchPublicDetails(other, '', { reviewsLimit: 1000 })).reviews.items.length, 1000);
  assert.equal(calls, 4);
});

test('同源同剧锁集跳转明确不可获取，不跟随或返回其他分集评论', async t => {
  t.mock.method(axios, 'get', async (url, options) => {
    assert.equal(options.maxRedirects, 0);
    throw { response: { status: 302, headers: { location: `/player/${SID}/1234567?pc_locked_episode=${VID}` } } };
  });
  const result = await fetchPublicDetails(SID, VID);
  assert.equal(result.success, false);
  assert.equal(result.code, 'EPISODE_COMMENTS_UNAVAILABLE');
  assert.equal(result.source_limited, true);
  assert.equal(result.items, undefined);
  assert.match(result.error, /未开放/);
});

test('跨站跨剧与普通跳转、HTTP错误和超时不误报来源未开放', async t => {
  const locations = [
    `https://example.com/player/${SID}/1234567?pc_locked_episode=${VID}`,
    `/player/1234567/1234567?pc_locked_episode=${VID}`,
    `/player/${SID}/1234567`,
    `/player/${SID}/1234567?pc_locked_episode=1234567`,
    `/detail?series_id=${SID}&pc_locked_episode=${VID}`,
    `https://user:pass@hongguoduanju.com/player/${SID}/1234567?pc_locked_episode=${VID}`,
    'http://[invalid',
  ];
  let failure;
  t.mock.method(axios, 'get', async () => { throw failure; });
  for (const location of locations) {
    failure = { response: { status: 302, headers: { location } } };
    const result = await fetchPublicDetails(SID, VID);
    assert.equal(result.success, false);
    assert.equal(result.code, undefined, location);
  }
  for (const status of [404, 503]) {
    failure = { response: { status, headers: { location: `/player/${SID}/1234567?pc_locked_episode=${VID}` } } };
    assert.equal((await fetchPublicDetails(SID, VID)).code, undefined);
  }
  failure = { code: 'ECONNABORTED' };
  assert.match((await fetchPublicDetails(SID, VID)).error, /超时/);
});
