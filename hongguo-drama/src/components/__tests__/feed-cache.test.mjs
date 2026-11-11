import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_CACHE_LIMIT, clearFeedCache, feedCacheKey, readFeedCache, writeFeedCache } from '../feedCache.mjs';

const item = id => ({ series_id: String(id), series_title: `剧${id}` });

test('feed cache separates App and website while other sources keep one catalog', () => {
  clearFeedCache();
  writeFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama', 'app'), [item(1)]);
  assert.equal(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama', 'web')), null);
  writeFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama', 'web'), [item(2)]);
  assert.deepEqual(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama')).items, [item(1)]);
  assert.deepEqual(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama', 'web')).items, [item(2)]);
  assert.equal(feedCacheKey(1, 'xifan', 'hot-drama', 'app'), feedCacheKey(1, 'xifan', 'hot-drama', 'web'));
});

test('feed cache is isolated by source revision, source and category', () => {
  clearFeedCache();
  writeFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama'), [item(1)], 1000);
  const cached = readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama'));
  assert.deepEqual(cached.items, [item(1)]);
  assert.equal(cached.savedAt, 1000);
  assert.equal(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-real-drama')), null);
  assert.equal(readFeedCache(feedCacheKey(1, 'xifan', 'hot-drama')), null);
  assert.equal(readFeedCache(feedCacheKey(2, 'hongguo', 'hot-drama')), null, 'a source edit must not reuse the previous revision');
});

test('feed cache never stores empty lists or malformed keys', () => {
  clearFeedCache();
  assert.equal(writeFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama'), []), null);
  assert.equal(writeFeedCache('', [item(1)]), null);
  assert.equal(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama')), null);
});

test('feed cache keeps the newest entries and drops the oldest', () => {
  clearFeedCache();
  for (let index = 0; index <= FEED_CACHE_LIMIT; index++) {
    writeFeedCache(feedCacheKey(1, 'hongguo', `page-${index}`), [item(index)], index);
  }
  assert.equal(readFeedCache(feedCacheKey(1, 'hongguo', 'page-0')), null, 'oldest entry must be evicted');
  assert.deepEqual(readFeedCache(feedCacheKey(1, 'hongguo', `page-${FEED_CACHE_LIMIT}`)).items, [item(FEED_CACHE_LIMIT)]);
});

test('clearFeedCache drops every revision and source', () => {
  clearFeedCache();
  writeFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama'), [item(1)]);
  writeFeedCache(feedCacheKey(1, 'xifan', 'hot-drama'), [item(2)]);
  clearFeedCache();
  assert.equal(readFeedCache(feedCacheKey(1, 'hongguo', 'hot-drama')), null);
  assert.equal(readFeedCache(feedCacheKey(1, 'xifan', 'hot-drama')), null);
});
