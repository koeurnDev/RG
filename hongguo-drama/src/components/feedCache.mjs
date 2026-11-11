// Session-scoped playlist cache for the discovery feed. It lives outside React so
// leaving and re-entering the page can paint the last list immediately and then
// revalidate against the source in the background.
export const FEED_CACHE_LIMIT = 24;

const cache = new Map();

export function feedCacheKey(revision, source, category, catalogChannel = 'app') {
  return `${revision}\u0000${source}\u0000${category}\u0000${source === 'hongguo' ? catalogChannel : ''}`;
}

export function readFeedCache(key) {
  return cache.get(key) || null;
}

export function writeFeedCache(key, items, savedAt = Date.now()) {
  if (typeof key !== 'string' || !key || !Array.isArray(items) || items.length === 0) return null;
  cache.delete(key);
  cache.set(key, { items, savedAt });
  while (cache.size > FEED_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return cache.get(key);
}

export function clearFeedCache() {
  cache.clear();
}
