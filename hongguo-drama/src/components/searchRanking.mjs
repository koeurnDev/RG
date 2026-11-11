/**
 * 搜索结果的标题归一化与相关性排序。
 * 全角/半角、空格和标点不影响匹配（例如“言出法随，诸天万界”与“言出法随 诸天万界”）。
 */
export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function rankSearchResults(results, keyword) {
  const query = normalizeSearchText(keyword), seen = new Set();
  return (Array.isArray(results) ? results : []).filter(item => {
    const key = `${item?.source}:${item?.series_id}`;
    if (!item?.series_id || !item?.series_title || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(item => {
    const title = normalizeSearchText(item.series_title);
    const description = normalizeSearchText(item.series_intro || item.description || '');
    const titleMatch = !!query && title.includes(query);
    // App 上新补搜支持“用户多打了季数/后缀”的反向匹配；这类结果仍算标题命中，
    // 不能因为标题比搜索词短就被排到“其他结果”里。
    const reverseMatch = item.new_release === true && title.length >= 2 && !!query && query.includes(title);
    const contentMatch = !!query && description.includes(query);
    return { ...item, contentMatch,
      relevance: title === query ? 0 : titleMatch ? 1 : reverseMatch ? 1 : contentMatch ? 2 : 3 };
  }).sort((a, b) => a.relevance - b.relevance || (a.fuzzy === b.fuzzy ? 0 : a.fuzzy ? -1 : 1));
}
