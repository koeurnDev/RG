const crypto = require('crypto');
const axios = require('axios');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');

const ORIGIN = 'https://m.mydramawave.com';
const API_URL = 'https://api.mydramawave.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID_RE = /^[A-Za-z0-9]{4,40}$/;

const READ_PATHS = new Set([
  '/h5-api/anonymous/login',
  '/h5-api/homepage/v2/tab/list',
  '/h5-api/homepage/v2/tab/index',
  '/h5-api/homepage/v2/tab/feed',
  '/h5-api/search/drama',
  '/h5-api/drama/info',
]);

let cachedConfig = null;
let cachedConfigAt = 0;
let sessionDeviceId = crypto.randomBytes(16).toString('hex');
let sessionAuth = null;
let loginInflight = null;

const detailCache = new Map();
const feedCursorCache = new Map();
const searchCursorCache = new Map();

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
  const s = String(value || '').trim();
  const parts = s.split(':');
  if (parts[0] !== 'dramawave' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((p) => ID_RE.test(p))) {
    throw new Error('DramaWave ID មិនត្រឹមត្រូវ');
  }
  return { dramaId: parts[1], chapterId: parts[2] || '', seriesId: `dramawave:${parts[1]}` };
}

function resolveSeriesId(input) {
  const s = String(input || '').trim();
  if (s.startsWith('dramawave:')) return parseId(s).seriesId;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new Error('Link DramaWave មិនត្រឹមត្រូវ');
  }
  if (!/(?:^|\.)mydramawave\.com$/i.test(u.hostname)) throw new Error('Link មិនមែនជា DramaWave ទេ');
  const m = u.pathname.match(/^\/series\/([A-Za-z0-9]{4,40})(?:\/|$)/);
  if (!m) throw new Error('មិនអាចរកឃើញ DramaWave Series ID ពី Link នេះទេ');
  return `dramawave:${m[1]}`;
}

function aesEncrypt(plainTextStr, keyBuf) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plainTextStr, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, enc]).toString('base64');
}

function aesDecrypt(b64Str, keyBuf) {
  const raw = Buffer.from(String(b64Str || '').trim(), 'base64');
  if (raw.length < 32) throw new Error('DramaWave response too short');
  const iv = raw.subarray(0, 16);
  const body = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function loadConfig(force = false) {
  if (!force && cachedConfig && Date.now() - cachedConfigAt < 30 * 60 * 1000) {
    return cachedConfig;
  }
  const htmlRes = await axios.get(`${ORIGIN}/`, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
    responseType: 'text',
  });
  const html = String(htmlRes.data || '');
  const srcMatch = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i);
  if (!srcMatch) throw new Error('DramaWave web bundle មិនអាចទាញយកបាន');
  const bundleUrl = new URL(srcMatch[1], ORIGIN);
  if (!['m.mydramawave.com', 'static-v1.mydramawave.com'].includes(bundleUrl.hostname)) {
    throw new Error('DramaWave bundle host មិនត្រឹមត្រូវ');
  }

  const jsRes = await axios.get(bundleUrl.href, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
    responseType: 'text',
  });
  const js = String(jsRes.data || '');

  const appSecret = js.match(/md5\(`([A-Za-z0-9]{16,64})&\$\{[^}]*auth_secret/)?.[1];
  const verMatch = js.match(/"app-version":[^:]+:"([^"]+)"/) || js.match(/Wn\("([^"]+)"\)/);
  const version = verMatch?.[1] || '1.6.20';

  const locales = {};
  for (const m of js.matchAll(/\{shortCode:"([^"]+)",name:"[^"]*",language:"([^"]+)",timezone:"([^"]+)",country:"([^"]+)"\}/g)) {
    const row = { shortCode: m[1], language: m[2], timezone: m[3], country: m[4] };
    locales[m[1]] = row;
    locales[m[2]] = row;
  }
  if (!locales.en) {
    locales.en = { shortCode: 'en', language: 'en-US', timezone: 'UTC', country: 'US' };
  }

  let keyStr = js.match(/ii="([A-Za-z0-9]{16})"/)?.[1] || '';
  if (!keyStr) {
    const cryptChunk = js.match(/crypt-web-[A-Za-z0-9_-]+\.js/)?.[0];
    if (cryptChunk) {
      const cryptUrl = new URL(cryptChunk, bundleUrl.href);
      const cryptJs = String((await axios.get(cryptUrl.href, { headers: { 'User-Agent': USER_AGENT }, timeout: 8000, responseType: 'text' })).data || '');
      keyStr = cryptJs.match(/="([A-Za-z0-9]{16})"\)\{/)?.[1] || '';
    }
  }

  if (!keyStr || !appSecret) {
    throw new Error('DramaWave protocol config បានផ្លាស់ប្តូរ');
  }

  cachedConfig = {
    key: Buffer.from(keyStr, 'utf8'),
    appSecret,
    version,
    locales,
  };
  cachedConfigAt = Date.now();
  return cachedConfig;
}

async function ensureLogin(cfg, language = 'en', force = false) {
  if (!force && sessionAuth && sessionAuth.authKey && sessionAuth.authSecret) {
    return sessionAuth;
  }
  if (!force && loginInflight) return loginInflight;
  loginInflight = (async () => {
    const data = await rawApiRequest('/h5-api/anonymous/login', {
      method: 'POST',
      data: { device_id: sessionDeviceId },
      language,
      guest: false,
      cfgOverride: cfg,
    });
    if (!data?.success || !data.auth_key || !data.auth_secret) {
      throw new Error('DramaWave anonymous login បរាជ័យ');
    }
    sessionAuth = { authKey: data.auth_key, authSecret: data.auth_secret };
    return sessionAuth;
  })().finally(() => { loginInflight = null; });
  return loginInflight;
}

async function rawApiRequest(apiPath, { method = 'GET', data = null, language = 'en', guest = true, cfgOverride = null, retryAuth = true } = {}) {
  if (!READ_PATHS.has(apiPath)) throw new Error('Unsupported DramaWave path');
  const cfg = cfgOverride || await loadConfig(false);
  const locale = cfg.locales[language] || cfg.locales.en;
  if (guest) await ensureLogin(cfg, language, false);

  const headers = {
    'app-name': 'com.dramawave.h5',
    'app-version': cfg.version,
    'device-hash': sessionDeviceId,
    'device-id': sessionDeviceId,
    device: 'h5',
    'Skip-Encrypt': '1',
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'User-Agent': USER_AGENT,
    ...locale,
  };
  if (sessionAuth) {
    const sig = crypto.createHash('md5').update(`${cfg.appSecret}&${sessionAuth.authSecret}`).digest('hex');
    headers.authorization = `oauth_signature=${sig},oauth_token=${sessionAuth.authKey},ts=${Date.now()}`;
  }

  const reqCfg = {
    method,
    url: `${API_URL}${apiPath}`,
    headers,
    timeout: 12000,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
  };
  if (method.toUpperCase() === 'POST') {
    reqCfg.data = JSON.stringify(data || {});
  } else if (data) {
    reqCfg.params = data;
  }

  const res = await axios(reqCfg);
  let parsed;
  try {
    parsed = JSON.parse(res.data);
  } catch (_) {
    try {
      parsed = JSON.parse(aesDecrypt(res.data, cfg.key));
    } catch (e) {
      throw new Error(`DramaWave HTTP ${res.status}: ទិន្នន័យមិនត្រឹមត្រូវ`);
    }
  }

  const code = parsed?.code;
  if (guest && retryAuth && (res.status === 401 || code === 401 || code === 403)) {
    sessionAuth = null;
    await ensureLogin(cfg, language, true);
    return rawApiRequest(apiPath, { method, data, language, guest, cfgOverride: cfg, retryAuth: false });
  }
  if (code !== 200 && code !== 0) {
    throw new Error(parsed?.msg || `DramaWave API error (${code ?? res.status})`);
  }
  return parsed.data || {};
}

function normalizeCard(raw) {
  const id = String(raw?.id || raw?.key || '').trim();
  if (!ID_RE.test(id)) return null;
  const title = plainText(raw.name || raw.title);
  if (!title) return null;
  const tags = Array.isArray(raw.series_tag) ? raw.series_tag
    : Array.isArray(raw.content_tags) ? raw.content_tags : [];
  return {
    series_id: `dramawave:${id}`,
    series_title: title,
    cover: safeHttpsUrl(raw.cover),
    description: plainText(raw.desc),
    episode_count: Number(raw.episode_count || raw.update_count) || 0,
    tags: tags.map((t) => plainText(typeof t === 'object' ? (t?.name || t?.label || t?.text) : t)).filter(Boolean).slice(0, 4),
    source: 'dramawave',
    url: `${ORIGIN}/series/${id}`,
  };
}

function dedupeCards(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const card = normalizeCard(row);
    if (!card || seen.has(card.series_id)) continue;
    seen.add(card.series_id);
    out.push(card);
  }
  return out;
}

const VIRTUAL_THEMES = [
  { slug: 'theme:ceo', keyword: 'ceo', label: '💼 CEO & Boss' },
  { slug: 'theme:billionaire', keyword: 'billionaire', label: '👑 Billionaire' },
  { slug: 'theme:wife', keyword: 'wife', label: '💍 Marriage & Wife' },
  { slug: 'theme:revenge', keyword: 'revenge', label: '⚔️ Revenge' },
  { slug: 'theme:divorce', keyword: 'divorce', label: '💔 Divorce' },
  { slug: 'theme:romance', keyword: 'romance', label: '🌹 Romance' },
];

async function browseList({ genre = '', page = 1 } = {}) {
  try {
    const pg = Math.max(1, Number(page) || 1);
    const tabsData = await rawApiRequest('/h5-api/homepage/v2/tab/list', { method: 'GET' });
    const tabs = Array.isArray(tabsData.list) ? tabsData.list : [];
    if (!tabs.length) throw new Error('DramaWave មិនមានបញ្ជីប្រភេទរឿងទេ');

    const officialGenres = tabs
      .filter((t) => t && t.tab_key != null)
      .map((t) => ({
        slug: `${t.tab_key}:${t.position_index ?? 0}`,
        label: plainText(t.name || t.business_name || t.tab_key),
      }))
      .filter((g) => g.label);
    const genres = [
      ...officialGenres,
      ...VIRTUAL_THEMES.map((t) => ({ slug: t.slug, label: t.label })),
    ];

    const themeHit = VIRTUAL_THEMES.find((t) => t.slug === genre);
    if (themeHit) {
      const sr = await search(themeHit.keyword, pg);
      if (!sr.success) throw new Error(sr.error || 'DramaWave theme load failed');
      return {
        success: true,
        results: sr.results,
        page: pg,
        hasMore: sr.hasMore,
        genres,
        pageTitle: 'DramaWave',
        sourceUrl: ORIGIN,
      };
    }

    const activeGenre = genre && officialGenres.some((g) => g.slug === genre)
      ? genre
      : (tabs.find((t) => t.business_name === 'popular')
        ? `${tabs.find((t) => t.business_name === 'popular').tab_key}:${tabs.find((t) => t.business_name === 'popular').position_index ?? 0}`
        : officialGenres[0]?.slug || '');

    if (pg === 1) {
      const [tabKey, posIdx] = activeGenre.split(':');
      const idxData = await rawApiRequest('/h5-api/homepage/v2/tab/index', {
        method: 'GET',
        data: { tab_key: tabKey, position_index: posIdx || '0', first: '' },
      });
      const modules = Array.isArray(idxData.items) ? idxData.items : [];
      const rec = modules.find((m) => m.type === 'recommend') || modules.find((m) => m.module_key) || {};
      const rows = modules.flatMap((m) => Array.isArray(m.items) ? m.items : []);
      const results = dedupeCards(rows);
      const nextCursor = idxData.page_info?.next || '';
      const hasMore = Boolean(idxData.page_info?.has_more && nextCursor && rec.module_key);
      if (hasMore) {
        feedCursorCache.set(`${activeGenre}:2`, { moduleKey: rec.module_key, next: nextCursor });
      }
      return { success: true, results, page: 1, hasMore, genres, pageTitle: 'DramaWave', sourceUrl: ORIGIN };
    }

    const cursor = feedCursorCache.get(`${activeGenre}:${pg}`);
    if (!cursor || !cursor.moduleKey || !cursor.next) {
      return { success: true, results: [], page: pg, hasMore: false, genres, pageTitle: 'DramaWave', sourceUrl: ORIGIN };
    }
    const feedData = await rawApiRequest('/h5-api/homepage/v2/tab/feed', {
      method: 'POST',
      data: { module_key: cursor.moduleKey, next: cursor.next },
    });
    const results = dedupeCards(Array.isArray(feedData.items) ? feedData.items : []);
    const nextCursor = feedData.page_info?.next || '';
    const hasMore = Boolean(feedData.page_info?.has_more && nextCursor && nextCursor !== cursor.next && results.length > 0);
    if (hasMore) {
      feedCursorCache.set(`${activeGenre}:${pg + 1}`, { moduleKey: cursor.moduleKey, next: nextCursor });
    }
    return { success: true, results, page: pg, hasMore, genres, pageTitle: 'DramaWave', sourceUrl: ORIGIN };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function search(keyword, page = 1) {
  try {
    const kw = plainText(keyword);
    const pg = Math.max(1, Number(page) || 1);
    if (!kw) throw new Error('សូមបញ្ចូលពាក្យស្វែងរក');
    const nextToken = pg > 1 ? (searchCursorCache.get(`${kw}:${pg}`) || '') : '';
    if (pg > 1 && !nextToken) return { success: true, results: [], page: pg, hasMore: false };
    const data = await rawApiRequest('/h5-api/search/drama', {
      method: 'POST',
      data: { scence: 'series_tag', next: nextToken, keyword: kw, timestamp: String(Date.now()) },
    });
    const results = dedupeCards(Array.isArray(data.items) ? data.items : []);
    const nextCursor = data.page_info?.next || '';
    const hasMore = Boolean(data.page_info?.has_more && nextCursor && results.length > 0);
    if (hasMore) searchCursorCache.set(`${kw}:${pg + 1}`, nextCursor);
    return { success: true, results, page: pg, hasMore };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getRawDetail(dramaId, force = false) {
  const cached = detailCache.get(dramaId);
  if (!force && cached && Date.now() - cached.at < 30 * 1000) return cached.raw;
  const data = await rawApiRequest('/h5-api/drama/info', { method: 'GET', data: { series_id: dramaId } });
  const raw = data?.info;
  if (!raw || String(raw.id) !== dramaId || !Array.isArray(raw.episode_list)) {
    throw new Error('មិនអាចទាញព័ត៌មានរឿងពី DramaWave បានទេ');
  }
  detailCache.set(dramaId, { at: Date.now(), raw });
  return raw;
}

async function fetchEpisodeList(seriesId, options = {}) {
  const { dramaId } = parseId(seriesId);
  const raw = await getRawDetail(dramaId, options.force === true);
  const title = plainText(raw.name || raw.title) || `DramaWave_${dramaId}`;
  const cover = safeHttpsUrl(raw.cover);
  const episodes = raw.episode_list
    .filter((ep) => ep && ep.id && ep.is_blooper !== true)
    .map((ep, idx) => {
      const chId = String(ep.id);
      const epNum = Number(ep.index) || (idx + 1);
      const playable = ep.unlock === true && ep.h5_available === true;
      return {
        vid: `dramawave:${dramaId}:${chId}`,
        vid_index: epNum,
        title: plainText(ep.name) || `EP ${epNum}`,
        series_id: `dramawave:${dramaId}`,
        series_title: title,
        cover,
        locked: !playable,
        source: 'dramawave',
      };
    })
    .sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('មិនមានបញ្ជីភាគសម្រាប់រឿង DramaWave នេះទេ');
  return {
    series_id: `dramawave:${dramaId}`,
    series_title: title,
    cover,
    intro: plainText(raw.desc),
    total: episodes.length,
    episodes,
    source: 'dramawave',
  };
}

async function fetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseId(vid, true);
    if (seriesId && parseId(seriesId).seriesId !== id.seriesId) {
      throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
    }
    const raw = await getRawDetail(id.dramaId, false);
    const ep = raw.episode_list.find((item) => String(item?.id) === id.chapterId);
    if (!ep) throw new Error('រកមិនឃើញភាគនេះលើ DramaWave');
    if (ep.unlock !== true) {
      return { url: null, locked: true, source: 'dramawave', error: `ភាគ ${ep.index || ''} ជាប់សោ VIP លើ DramaWave` };
    }
    if (ep.h5_available !== true) {
      return { url: null, locked: true, source: 'dramawave', error: `ភាគ ${ep.index || ''} តម្រូវឱ្យមើលលើ App ផ្លូវការ` };
    }
    const mediaUrl = safeHttpsUrl(
      ep.external_audio_h264_m3u8 || ep.m3u8_url || ep.video_url || ep.external_audio_h265_m3u8
    );
    if (!mediaUrl) throw new Error('DramaWave មិនបានផ្ដល់ Link វីដេអូសម្រាប់ភាគនេះទេ');
    const pathname = new URL(mediaUrl).pathname.toLowerCase();
    const format = pathname.endsWith('.m3u8') ? 'hls' : 'mp4';
    return {
      url: mediaUrl,
      format,
      source: 'dramawave',
      spadeA: null,
      codec: '',
      vid,
      userAgent: USER_AGENT,
      referer: `${ORIGIN}/`,
    };
  } catch (err) {
    return { url: null, source: 'dramawave', spadeA: null, codec: null, error: err.message };
  }
}

module.exports = {
  resolveSeriesId,
  browseList,
  search,
  fetchEpisodeList,
  fetchPlayUrlSingle,
  _aesEncrypt: aesEncrypt,
  _aesDecrypt: aesDecrypt,
};
