const crypto = require('crypto');
const axios = require('axios');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');

const ORIGIN = 'https://www.goodshort.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID_RE = /^\d{1,24}$/;

let cachedGenres = null;
const detailCache = new Map();

function plainText(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim();
}

function safeHttpsUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && isPublicMediaUrl(u.href) ? u.href : '';
  } catch (_) {
    return '';
  }
}

function parseId(value, episode = false) {
  const parts = String(value || '').trim().split(':');
  if (parts[0] !== 'goodshort' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((p) => ID_RE.test(p))) {
    throw new Error('GoodShort ID មិនត្រឹមត្រូវ');
  }
  return { bookId: parts[1], chapterId: parts[2] || '', seriesId: `goodshort:${parts[1]}` };
}

function resolveSeriesId(input) {
  const s = String(input || '').trim();
  if (s.startsWith('goodshort:')) return parseId(s).seriesId;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new Error('Link GoodShort មិនត្រឹមត្រូវ');
  }
  if (!/(?:^|\.)goodshort\.com$/i.test(u.hostname)) throw new Error('Link មិនមែនជា GoodShort ទេ');
  const m = u.pathname.match(/(\d{6,20})\/?$/) || u.pathname.match(/-(\d{6,20})(?:\/|$)/);
  if (!m) throw new Error('មិនអាចរកឃើញ GoodShort Book ID ពី Link នេះទេ');
  return `goodshort:${m[1]}`;
}

async function apiRequest(apiPath, data = {}, language = 'en') {
  if (!apiPath.startsWith('/hwycreels/')) throw new Error('Unsupported GoodShort path');
  const reqId = `GR${crypto.randomInt(100000000000, 999999999999)}`;
  const res = await axios.post(`${ORIGIN}${apiPath}`, data, {
    headers: {
      platform: 'WEB',
      currentLanguage: language,
      requestId: reqId,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    timeout: 12000,
    validateStatus: () => true,
  });
  const body = res.data;
  if (!body || typeof body !== 'object') throw new Error(`GoodShort HTTP ${res.status}`);
  if (body.status !== 0 || !body.data || typeof body.data !== 'object') {
    throw new Error(body.message || `GoodShort API rejected (${body.status ?? res.status})`);
  }
  return body.data;
}

function normalizeBook(book) {
  const bid = String(book?.bookId || book?.sourceId || (book?.actionType === 'BOOK' ? book?.action : '') || '').trim();
  if (!ID_RE.test(bid)) return null;
  const title = plainText(book.seoBookName || book.bookName || book.name);
  if (!title) return null;
  return {
    series_id: `goodshort:${bid}`,
    series_title: title,
    cover: safeHttpsUrl(book.cover || book.bannerUrl),
    description: plainText(book.introduction),
    episode_count: Number(book.chapterCount) || 0,
    tags: Array.isArray(book.tagsList) ? book.tagsList.map((t) => plainText(t?.name)).filter(Boolean).slice(0, 4) : [],
    source: 'goodshort',
    url: book.bookResourceUrl ? `${ORIGIN}/drama/${encodeURIComponent(book.bookResourceUrl)}` : ORIGIN,
  };
}

function dedupeBooks(list = []) {
  const seen = new Set();
  const out = [];
  for (const b of list) {
    const card = normalizeBook(b);
    if (!card || seen.has(card.series_id)) continue;
    seen.add(card.series_id);
    out.push(card);
  }
  return out;
}

async function browseList({ genre = '', page = 1 } = {}) {
  try {
    const pg = Math.max(1, Number(page) || 1);
    if (!cachedGenres || (!genre && pg === 1)) {
      const home = await apiRequest('/hwycreels/home/index', { language: 'en' });
      const cols = Array.isArray(home.pageColumns) ? home.pageColumns : [];
      cachedGenres = cols
        .filter((c) => c && c.style !== 'BANNER' && c.columnResourceUrl && plainText(c.name))
        .map((c) => ({ slug: String(c.columnResourceUrl), label: plainText(c.name) }));

      if (!genre && pg === 1) {
        const rawBooks = cols.flatMap((c) => Array.isArray(c.items) ? c.items : []);
        const results = dedupeBooks(rawBooks);
        return {
          success: true,
          results,
          page: 1,
          hasMore: cachedGenres.length > 0,
          genres: cachedGenres,
          pageTitle: 'GoodShort',
          sourceUrl: ORIGIN,
        };
      }
    }

    const colUrl = genre || cachedGenres?.[0]?.slug || 'Most-Trending';
    const data = await apiRequest('/hwycreels/home/second/list', {
      columnResourceUrl: colUrl,
      pageNo: pg,
      pageSize: 20,
      index: 0,
      language: 'en',
    });
    const results = dedupeBooks(Array.isArray(data.items) ? data.items : []);
    const total = Number(data.totalSize || 0);
    const totalPages = Math.max(1, Math.ceil(total / 20));
    return {
      success: true,
      results,
      page: pg,
      hasMore: results.length > 0 && pg < totalPages,
      genres: cachedGenres || [],
      pageTitle: 'GoodShort',
      sourceUrl: ORIGIN,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function search(keyword, page = 1) {
  try {
    const kw = plainText(keyword);
    const pg = Math.max(1, Number(page) || 1);
    if (!kw) throw new Error('សូមបញ្ចូលពាក្យស្វែងរក');
    const data = await apiRequest('/hwycreels/book/search/seo', {
      seoKeywordFormat: kw,
      keyword: kw,
      pageNo: pg,
      pageSize: 18,
      language: 'en',
      type: 'DEFAULT',
      isSetCookiesAgain: '',
      seoSearch: true,
    });
    const pageObj = data.page;
    if (!pageObj) return { success: true, results: [], page: pg, hasMore: false };
    const results = dedupeBooks(Array.isArray(pageObj.records) ? pageObj.records : []);
    const pages = Number(pageObj.pages) || 1;
    return {
      success: true,
      results,
      page: pg,
      hasMore: results.length > 0 && pg < pages,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchEpisodeList(seriesId, options = {}) {
  const { bookId } = parseId(seriesId);
  const cached = detailCache.get(bookId);
  if (options.force !== true && cached && Date.now() - cached.at < 30 * 1000) {
    return cached.data;
  }
  const detailData = await apiRequest('/hwycreels/book/detail', { bookId });
  const book = detailData.book;
  if (!book || String(book.bookId) !== bookId) {
    throw new Error('មិនអាចទាញព័ត៌មានរឿងពី GoodShort បានទេ');
  }

  const records = [];
  let pageNo = 1;
  while (pageNo <= 100) {
    const pageData = await apiRequest('/hwycreels/chapter/page', { bookId, pageNo, pageSize: 100 });
    const list = Array.isArray(pageData.records) ? pageData.records : [];
    records.push(...list);
    if (pageNo >= Number(pageData.pages || 1) || list.length === 0) break;
    pageNo++;
  }

  const title = plainText(book.seoBookName || book.bookName || book.name) || `GoodShort_${bookId}`;
  const cover = safeHttpsUrl(book.cover || book.bannerUrl);
  const episodes = records
    .filter((ch) => ch && ID_RE.test(String(ch.id || '')))
    .map((ch, idx) => {
      const chId = String(ch.id);
      const epNum = Number.isFinite(Number(ch.index)) ? Number(ch.index) + 1 : (idx + 1);
      return {
        vid: `goodshort:${bookId}:${chId}`,
        vid_index: epNum,
        title: plainText(ch.seoChapterName || ch.chapterName) || `EP ${epNum}`,
        series_id: `goodshort:${bookId}`,
        series_title: title,
        cover,
        locked: Number(ch.price || 0) > 0,
        source: 'goodshort',
      };
    })
    .sort((a, b) => a.vid_index - b.vid_index);

  if (!episodes.length) throw new Error('មិនមានបញ្ជីភាគសម្រាប់រឿង GoodShort នេះទេ');
  const out = {
    series_id: `goodshort:${bookId}`,
    series_title: title,
    cover,
    intro: plainText(book.introduction),
    total: episodes.length,
    episodes,
    source: 'goodshort',
  };
  detailCache.set(bookId, { at: Date.now(), data: out });
  return out;
}

async function fetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseId(vid, true);
    if (seriesId && parseId(seriesId).seriesId !== id.seriesId) {
      throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
    }
    const ch = await apiRequest('/hwycreels/chapter/detail', {
      bookId: id.bookId,
      chapterId: id.chapterId,
      num: 16,
    });
    if (!ch || String(ch.id) !== id.chapterId || String(ch.bookId) !== id.bookId) {
      throw new Error('GoodShort បញ្ជូនទិន្នន័យភាគមិនត្រូវគ្នា');
    }
    if (Number(ch.price || 0) > 0) {
      return { url: null, locked: true, source: 'goodshort', error: 'ភាគនេះជាប់សោ VIP/Coins លើ GoodShort' };
    }
    const mediaUrl = safeHttpsUrl(ch.m3u8Path);
    if (!mediaUrl) throw new Error('GoodShort មិនបានផ្ដល់ Link វីដេអូសម្រាប់ភាគនេះទេ');
    const format = /\.m3u8(\?|$)/i.test(mediaUrl) ? 'hls' : 'mp4';
    return {
      url: mediaUrl,
      format,
      source: 'goodshort',
      spadeA: null,
      codec: '',
      vid,
      userAgent: USER_AGENT,
      referer: `${ORIGIN}/`,
    };
  } catch (err) {
    return { url: null, source: 'goodshort', spadeA: null, codec: null, error: err.message };
  }
}

module.exports = {
  resolveSeriesId,
  browseList,
  search,
  fetchEpisodeList,
  fetchPlayUrlSingle,
};
