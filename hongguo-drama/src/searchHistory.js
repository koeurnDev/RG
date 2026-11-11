const STORAGE_KEY = 'hongguo-experience-preview:search-history';
const catalogTitles = new Set();

function normalizeTerms(values) {
  return [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter((value) => value && value.length <= 120))];
}

export function readSearchHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? normalizeTerms(stored).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function saveSearchTerm(term) {
  const history = normalizeTerms([term, ...readSearchHistory()]).slice(0, 12);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return history;
}

export function removeSearchTerm(term) {
  const history = readSearchHistory().filter(value => value !== term);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return history;
}

export function clearSearchHistory() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function rememberCatalogTitles(results) {
  for (const title of normalizeTerms(results.map((item) => item?.series_title))) {
    catalogTitles.delete(title);
    catalogTitles.add(title);
  }
  while (catalogTitles.size > 300) catalogTitles.delete(catalogTitles.values().next().value);
}

export function getSearchSuggestions(keyword, history) {
  const query = keyword.trim().toLocaleLowerCase();
  const terms = normalizeTerms([...history, ...catalogTitles]);
  return terms.filter((term) => !query || term.toLocaleLowerCase().includes(query)).slice(0, 12).map((term) => ({
    term,
    source: history.includes(term) ? '搜索历史' : '本次浏览过的剧名',
  }));
}
