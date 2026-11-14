const axios = require('axios');
const hongguo = require('../hongguo-drama/src/native/hongguo');
const reelshort = require('../hongguo-drama/src/native/reelshort');
const hema = require('../hongguo-drama/src/native/hema');
const xifan = require('../hongguo-drama/src/native/xifan');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');

const DRAMABOX_ORIGIN = 'https://www.dramabox.com';
const DRAMABOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DRAMABOX_ID_RE = /^\d{1,24}$/;

const SOURCES = [
  { id: 'hongguo', label: '🔥 HongGuo (红果)', shortLabel: 'HongGuo', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'dramabox', label: '🎬 DramaBox', shortLabel: 'DramaBox', lang: 'en', hasCategories: false, hasSearch: true },
  { id: 'reelshort', label: '🎭 ReelShort', shortLabel: 'ReelShort', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'hema', label: '🦛 Hema (河马)', shortLabel: 'Hema', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'xifan', label: '🍱 Xifan (西饭)', shortLabel: 'Xifan', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'social', label: '🌐 Social / Link (TikTok, YT...)', shortLabel: 'Social Video', lang: 'multi', hasCategories: false, hasSearch: false },
];

const sourceGenresCache = new Map();
const sourceCatalogCache = new Map();
const inflightCatalog = new Map();
const GENRE_CACHE_TTL_MS = 15 * 60 * 1000;
const CATALOG_CACHE_TTL_MS = 3 * 60 * 1000;

function stripHtmlText(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim();
}

// ===== DramaBox SSR Adapter (supports same-origin 301 slug redirects on www.dramabox.com) =====
function parseDramaBoxId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'dramabox' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((p) => DRAMABOX_ID_RE.test(p))) {
    throw new Error('លេខកូដរឿង DramaBox មិនត្រឹមត្រូវ');
  }
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}

function assertDramaBoxUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new Error('DramaBox URL មិនត្រឹមត្រូវ'); }
  if (u.protocol !== 'https:' || !['www.dramabox.com', 'www.dramaboxdb.com'].includes(u.hostname)) {
    throw new Error('DramaBox តំណមិនត្រឹមត្រូវ');
  }
  return u;
}

async function dramaboxRequest(route, params = {}, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 12000;
  if (remaining <= 0) throw new Error('DramaBox អស់ពេលតភ្ជាប់ សូមព្យាយាមម្តងទៀត');
  const timeout = Math.min(12000, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let targetUrl = DRAMABOX_ORIGIN + route;
    let response = null;
    for (let hop = 0; hop < 4; hop += 1) {
      assertDramaBoxUrl(targetUrl);
      response = await axios.get(targetUrl, {
        params: hop === 0 ? params : {},
        timeout,
        signal: controller.signal,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        maxContentLength: 8 * 1024 * 1024,
        responseType: 'text',
        headers: {
          'User-Agent': DRAMABOX_UA,
          Referer: `${DRAMABOX_ORIGIN}/`,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        targetUrl = new URL(response.headers.location, targetUrl).href;
        continue;
      }
      break;
    }
    const raw = String(response?.data || '').match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
    if (!raw) throw new Error('DramaBox មិនមានទិន្នន័យរឿងទេ');
    const data = JSON.parse(raw);
    const props = data?.props?.pageProps;
    if (!props || typeof props !== 'object') throw new Error('DramaBox ទម្រង់ទិន្នន័យមិនត្រឹមត្រូវ');
    return props;
  } catch (error) {
    const status = error.response?.status;
    if ([403, 451].includes(status)) throw new Error(`DramaBox ត្រូវបានកម្រិតតំបន់ (HTTP ${status})`);
    if (status === 429) throw new Error('DramaBox ស្នើសុំច្រើនពេក សូមរង់ចាំបន្តិច');
    if (error.message && /DramaBox/.test(error.message)) throw error;
    throw new Error('មិនអាចភ្ជាប់ទៅ DramaBox បានទេ សូមព្យាយាមម្តងទៀត');
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDramaBoxBook(book) {
  if (!book || !DRAMABOX_ID_RE.test(String(book.bookId)) || !stripHtmlText(book.bookName || book.name)) return null;
  const cover = isPublicMediaUrl(book.cover || book.coverWap) ? (book.cover || book.coverWap) : '';
  return {
    series_id: `dramabox:${book.bookId}`,
    series_title: stripHtmlText(book.bookName || book.name),
    cover,
    episode_count: Number(book.chapterCount ?? book.totalChapterNum) || 0,
    intro: stripHtmlText(book.introduction),
    source: 'dramabox',
    url: `${DRAMABOX_ORIGIN}/drama/${book.bookId}`,
  };
}

async function dramaboxBrowse({ page = 1 } = {}) {
  const props = await dramaboxRequest(page === 1 ? '/browse' : `/browse/0/${page}`);
  const results = (props.bookList || []).map(normalizeDramaBoxBook).filter(Boolean);
  const pages = Number(props.pages) || 1;
  return { success: true, results, page, hasMore: results.length > 0 && page < pages, genres: [] };
}

async function dramaboxSearch(keyword, page = 1) {
  const searchValue = String(keyword || '').trim();
  if (!searchValue) return { success: true, results: [], hasMore: false };
  const props = await dramaboxRequest('/search', { searchValue, page });
  const results = (props.bookList || []).map(normalizeDramaBoxBook).filter(Boolean);
  const pages = Number(props.totalPage) || 1;
  return { success: true, results, page, hasMore: results.length > 0 && page < pages };
}

async function dramaboxFetchEpisodeList(seriesId, options = {}) {
  const id = parseDramaBoxId(seriesId);
  const props = await dramaboxRequest(`/drama/${id.bookId}`, {}, options);
  const book = normalizeDramaBoxBook(props.bookInfo);
  const chapters = Array.isArray(props.chapterList) ? props.chapterList : [];
  if (!book || !chapters.length) throw new Error('DramaBox មិនមានបញ្ជីភាគទេ');
  const sorted = [...chapters].sort((a, b) => Number(a.index) - Number(b.index));
  return {
    ...book,
    total: sorted.length,
    episodes: sorted.map((chapter, idx) => ({
      vid: `${seriesId}:${chapter.id}`,
      vid_index: (Number.isFinite(Number(chapter.index)) ? Number(chapter.index) + 1 : idx + 1),
      title: stripHtmlText(chapter.name) || `ភាគទី ${idx + 1}`,
      series_id: seriesId,
      series_title: book.series_title,
      cover: book.cover,
      duration: Number(chapter.duration) / 1000 || 0,
      locked: chapter.unlock !== true,
      source: 'dramabox',
    })),
  };
}

async function dramaboxFetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseDramaBoxId(vid, true);
    if (seriesId && seriesId !== id.seriesId) throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
    const props = await dramaboxRequest(`/drama/${id.bookId}`);
    const chapters = Array.isArray(props.chapterList) ? props.chapterList : [];
    const chapter = chapters.find((c) => String(c.id) === id.chapterId);
    if (!chapter) throw new Error('រកមិនឃើញភាគនេះក្នុង DramaBox ទេ');
    if (chapter.unlock !== true) {
      return { url: null, locked: true, source: 'dramabox', error: `ភាគ ${Number(chapter.index) + 1} ជាប់សោ VIP លើ DramaBox` };
    }
    const rawUrl = chapter.mp4 || chapter.videoUrl || (Array.isArray(chapter.cdnList) && chapter.cdnList[0]?.videoPathList?.[0]?.videoPath) || '';
    const url = rawUrl && isPublicMediaUrl(rawUrl) ? String(rawUrl) : '';
    if (!url) {
      return { url: null, locked: true, source: 'dramabox', error: 'DramaBox មិនផ្ដល់ Link MP4 ឥតគិតថ្លៃសម្រាប់ភាគនេះទេ' };
    }
    return {
      url,
      format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
      source: 'dramabox',
      codec: 'h264',
      quality: 'HD',
      spadeA: null,
      userAgent: DRAMABOX_UA,
      referer: `${DRAMABOX_ORIGIN}/`,
    };
  } catch (err) {
    return { url: null, source: 'dramabox', error: err.message };
  }
}

// ===== Unified Router & Normalizers =====
function detectSourceFromId(idOrUrl) {
  const s = String(idOrUrl || '').trim();
  if (!s) return 'hongguo';
  if (s.startsWith('dramabox:')) return 'dramabox';
  if (s.startsWith('reelshort:')) return 'reelshort';
  if (s.startsWith('hema:')) return 'hema';
  if (s.startsWith('xifan:')) return 'xifan';
  if (/^https?:\/\/(?:www\.)?dramabox(?:db)?\.com\/(?:drama|movie)\/\d+/i.test(s)) return 'dramabox';
  if (/^https?:\/\/(?:www\.)?reelshort\.com\/(?:movie|episodes)\//i.test(s)) return 'reelshort';
  return 'hongguo';
}

function resolveDramaUrlOrId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.startsWith('dramabox:') || /^https?:\/\/(?:www\.)?dramabox(?:db)?\.com\/(?:drama|movie)\/\d+/i.test(s)) {
    const m = s.startsWith('dramabox:') ? s : s.match(/\/(?:drama|movie)\/(\d{1,24})/)?.[1];
    return m ? (m.startsWith('dramabox:') ? m : `dramabox:${m}`) : null;
  }
  if (s.startsWith('reelshort:') || /^https?:\/\/(?:www\.)?reelshort\.com\//i.test(s)) {
    try { return reelshort.resolveSeriesId(s); } catch (_) { return null; }
  }
  if (s.startsWith('hema:')) return s;
  if (s.startsWith('xifan:')) return s;
  return null;
}

function normalizeCatalogItem(item, source, tag = '', translateTitle = null) {
  const sid = String(item.series_id || item.id || '');
  const title = stripHtmlText(item.series_title || item.title || '');
  const cover = hongguo.normalizeCoverUrl ? hongguo.normalizeCoverUrl(item.cover || '') : (item.cover || '');
  return {
    id: sid,
    seriesId: sid,
    title,
    titleKhmer: translateTitle ? translateTitle(title) : '',
    cover,
    total: Number(item.episode_count || item.total) || 0,
    tag: tag || source.toUpperCase(),
    source,
  };
}

function getSourceAdapter(sourceId) {
  switch (sourceId) {
    case 'dramabox':
      return {
        browseList: dramaboxBrowse,
        search: dramaboxSearch,
        fetchEpisodeList: dramaboxFetchEpisodeList,
        fetchPlayUrlSingle: dramaboxFetchPlayUrlSingle,
      };
    case 'reelshort':
      return reelshort;
    case 'hema':
      return hema;
    case 'xifan':
      return xifan;
    default:
      return hongguo;
  }
}

function mapGenresList(rawGenres) {
  const raw = Array.isArray(rawGenres) ? rawGenres : [];
  return [
    { id: '', name: '🔥 ពេញនិយម' },
    ...raw.slice(0, 24).map((g) => ({
      id: String(g.slug || g.id || ''),
      name: String(g.label || g.name || g.slug || ''),
    })).filter((g) => g.id),
  ];
}

async function getSourceCategories(sourceId) {
  if (sourceId === 'dramabox') {
    return [{ id: '', name: '🔥 ពេញនិយម (Popular)' }];
  }
  if (sourceId === 'social') return [];
  const cached = sourceGenresCache.get(sourceId);
  if (cached && Date.now() - cached.at < GENRE_CACHE_TTL_MS) {
    return cached.list;
  }
  const resCat = await browseSourceCatalog(sourceId, { genre: '', page: 1 }).catch(() => null);
  return (resCat && resCat.categories) || sourceGenresCache.get(sourceId)?.list || [{ id: '', name: '🔥 ពេញនិយម' }];
}

async function browseSourceCatalog(sourceId, { genre = '', page = 1 } = {}, translateTitle = null) {
  const pg = Math.max(1, Number(page) || 1);
  const gSlug = (genre && sourceId !== 'dramabox') ? String(genre) : '';
  const cacheKey = `${sourceId}:${gSlug}:${pg}`;
  const cached = sourceCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_CACHE_TTL_MS) {
    return cached.data;
  }
  if (inflightCatalog.has(cacheKey)) {
    return inflightCatalog.get(cacheKey);
  }

  const p = (async () => {
    const adapter = getSourceAdapter(sourceId);
    const opts = { page: pg };
    if (gSlug) opts.genre = gSlug;

    let res = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        res = await adapter.browseList(opts);
        if (res && res.success !== false && Array.isArray(res.results)) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 450));
      } catch (err) {
        if (attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 450));
      }
    }
    if (res && res.success === false && res.error) {
      throw new Error(res.error);
    }
    const results = Array.isArray(res?.results) ? res.results : [];
    if (Array.isArray(res?.genres) && res.genres.length > 0) {
      sourceGenresCache.set(sourceId, { at: Date.now(), list: mapGenresList(res.genres) });
    }
    const categories = sourceId === 'dramabox'
      ? [{ id: '', name: '🔥 ពេញនិយម (Popular)' }]
      : (sourceGenresCache.get(sourceId)?.list || [{ id: '', name: '🔥 ពេញនិយម' }]);

    const data = {
      dramas: results.map((item) => normalizeCatalogItem(item, sourceId, gSlug || sourceId.toUpperCase(), translateTitle)),
      hasMore: Boolean(res?.hasMore),
      categories,
    };
    if (data.dramas.length > 0) {
      sourceCatalogCache.set(cacheKey, { at: Date.now(), data });
    }
    return data;
  })().finally(() => inflightCatalog.delete(cacheKey));

  inflightCatalog.set(cacheKey, p);
  return p;
}

async function searchSource(sourceId, keyword, page = 1, translateTitle = null) {
  const adapter = getSourceAdapter(sourceId);
  const res = await adapter.search(keyword, page);
  if (res && res.success === false && res.error) {
    throw new Error(res.error);
  }
  const results = Array.isArray(res?.results) ? res.results : [];
  return results.map((item) => normalizeCatalogItem(item, sourceId, sourceId.toUpperCase(), translateTitle));
}

async function fetchEpisodeListUnified(seriesId, options = {}) {
  const src = detectSourceFromId(seriesId);
  const adapter = getSourceAdapter(src);
  const info = await adapter.fetchEpisodeList(seriesId, options);
  const episodes = Array.isArray(info?.episodes) ? info.episodes.map((ep, idx) => ({
    ...ep,
    vid_index: Number(ep.vid_index) || (idx + 1),
    locked: Boolean(ep.locked),
    source: ep.source || src,
  })) : [];
  return {
    ...info,
    series_id: String(info?.series_id || seriesId),
    source: info?.source || src,
    episodes,
  };
}

async function fetchPlayUrlUnified(vid, seriesId, options = {}) {
  const src = detectSourceFromId(seriesId || vid);
  if (src === 'hongguo') {
    return hongguo.fetchPlayUrlSingle(vid, seriesId, options);
  }
  const adapter = getSourceAdapter(src);
  return adapter.fetchPlayUrlSingle(vid, seriesId);
}

module.exports = {
  SOURCES,
  detectSourceFromId,
  resolveDramaUrlOrId,
  getSourceCategories,
  browseSourceCatalog,
  searchSource,
  fetchEpisodeListUnified,
  fetchPlayUrlUnified,
  normalizeCatalogItem,
};

