const axios = require('axios');
const crypto = require('crypto');
const http2 = require('http2');
const zlib = require('zlib');
const hongguo = require('../hongguo-drama/src/native/hongguo');
const catalog = require('../hongguo-drama/src/native/catalog');
const { searchHongguo } = require('../hongguo-drama/src/native/hongguo-search');
const reelshort = require('../hongguo-drama/src/native/reelshort');
const hema = require('../hongguo-drama/src/native/hema');
const xifan = require('../hongguo-drama/src/native/xifan');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');

const DRAMABOX_ORIGIN = 'https://www.dramabox.com';
const DRAMABOX_WEBFIC_URL = 'https://www.webfic.com';
const DRAMABOX_SAPI_HOSTS = ['sapi.dramaboxdb.com', 'sapih3.dramaboxdb.com', 'sapi.dramaboxapp.com'];
const DRAMABOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DRAMABOX_APP_UA = 'Dalvik/2.1.0 (Linux; U; Android 13; V2309A Build/TQ3A.230805.001)';
const DRAMABOX_TLS_CIPHERS = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
const DRAMABOX_ID_RE = /^\d{1,24}$/;

const DRAMABOX_RSA_JWK = {
  kty: 'RSA',
  n: 'vUOGOUF-Y9PB6522N4q3ynZBJZQFNjjkZwI5Vw8gs3JtmemUaxr7U2VADHpX1OT1kulxhJt3eJCRCm14uAq5fKNhPxN2CT5NZUA9XdCU3a72ZXhEzdVYh2RUkMEty_eFqIdBN0z3m2hGKvPHhMbyrtbQ3Y0qBYwW4DHs8kp2rOTXNsRdvF4T7gvJtebvnXnLbKyZfgCxnEw19y79xVEbsFf3Te1jBJIHLHiClTHScc1AdD3kqgjX7X8ZnQVf1OMlxUcT4Z0hUlwq5I-riY4nJImKtaUNWmX60HtXiw9zAdoSqu3K4THAN5KYIEJZ5stcEUeAQLbZklOHz2_8hfA94Q',
  e: 'AQAB',
  d: 'l2u7qnlEtneH8YsXau53xuq_imIXnV79FZDI8WcwAYGuQHKJhPtsUjdye8kyFiksdGKCqNZ9Sh9Xe2FEMPKbniVUu1NFn3WSFEzGDBXB1G6TwXDsk0V6c7AInFuB2WrqK4Ay5ByXCWXupZSubwOAy_Mf3fF_yjpfXvVynhKHSiDVFrsT0Znft3MGVfZokErxUF9y1me24M_HnZ7vWdp-p9uNfFm4S2m73agl3oD2ZZt3QFlOTvZkdSYNwpyqN9wQfX1JY6mEwkViTFTkVGggSvf_OKzJM7gy3fdmbAQs6tj092XIADJ53tmgf6GVOvtzTblBE69vYuaqBGJRPnq0wQ',
  p: '-jH5m6iMRK6XjiBhSUnlr3DzRybwlQrtIj5sZprWe2my5uYHG3jbViYIO7GtQvMTnDrBCxNhuM6dPrL0cRnbsp_iBMXe3pyjT_aWveBkn4R-UpBsnbtDn28r1MZpCDtr5UNc0TPj4KFJvjnV_e8oGoyYEroECqcw1LqNOGDiLhk',
  q: 'waemNePYrXW-MVX_hatfLQ96tpxwf7yuHdENZ2q5AFw73GJWYvC8VY-TcoKPAmeoCUMltI3TrS6K5Q_GoLd5K2BsoJrSxQNQFd3ehWAtdOuPDvQ5rn_2fsvgvc3rOvJh7uNnwEZCI_45WQg-UFWref4PPc-ArNtp9Xj2y7Lndwk',
  dp: 'EaIyEHl5oWGYxuibUroFmS7hxpMFA8woWHCD3VtuYHZbqJBv0czb0J-Plv13068kI6-0aV5tVcQiKwgb2FjVNiq0mFeF1LS_geRETY-iJ-gDqzgIn7lSE8uXEEEHqA_gE-GCijAZEHztoJ2c6m_PqMdd9Hvtyv5rn6KiT2Xsqwk',
  dq: 'LZ-huPCFC9jBhj4MhSFquuL6tisFFhMNslieH8805rDUKYfBcm3k8QNyaXf42UgyfnwjVfZT-GkOsAiXcyXGlkGRVgUjwuaU55Ht6t5N103n1k4TiNj86cJ-oDjzQl_4Up-gwdvLmU87k44toB-O1p7UWGualR7cR8jH3BW6EoE',
  qi: '8XMcpBlsaGSqbI9bZy1MQhYt1QfI7ft-bx2PVaM3jCNEAjiiE2IpAlGHdATXUTU_MFOX2VlVZPxC0SxKOesD-2kavfvx9xRPtYYGBOYFFoCe_U_Wf9OnRNK-HlekiGEy7FyK0iCuFgwgbcZs_0k0BqvE7-o9boaLTFZoXuKXs6s',
};

let dramaboxPrivateKey = null;
let dramaboxSession = null;
let dramaboxCustomToken = '';
const dramaboxEpisodeCache = new Map();
const DRAMABOX_EP_CACHE_TTL_MS = 10 * 60 * 1000;

function setCustomDramaBoxToken(tokenStr = '') {
  const clean = String(tokenStr || '').replace(/^Bearer\s+/i, '').trim();
  dramaboxCustomToken = clean;
  dramaboxSession = null;
  dramaboxEpisodeCache.clear();
  return getCustomDramaBoxTokenStatus();
}

function getCustomDramaBoxTokenStatus() {
  const hasToken = Boolean(dramaboxCustomToken);
  const masked = hasToken
    ? `${dramaboxCustomToken.slice(0, 8)}...${dramaboxCustomToken.slice(-6)}`
    : '';
  return { hasCustomToken: hasToken, maskedToken: masked };
}

const DRAMABOX_KHMER_GENRE_LABELS = {
  'Werewolves': '🐺 បិសាចចចក (Werewolves)',
  'Revenge': '⚡ សងសឹក (Revenge)',
  'Avenge': '🔥 សងសឹកស្នេហ៍ (Avenge)',
  'Divine Tycoon': '💎 មហាសេដ្ឋី (Divine Tycoon)',
  'Love Triangle': '💔 ស្នេហាត្រីកោណ (Love Triangle)',
  'Paranormal': '👻 អភិនីហារ (Paranormal)',
  'Cinderella': '👠 ស៊ីនឌឺរ៉េឡា (Cinderella)',
  'Underdog Rise': '🚀 តស៊ូជោគជ័យ (Underdog)',
  'Modern': '🏙️ សម័យទំនើប (Modern)',
  'Historical': '🏯 បុរាណ (Historical)',
  'CEO': '👔 អគ្គនាយក (CEO)',
  'Billionaire': '💰 មហាសេដ្ឋី (Billionaire)',
  'Romance': '💕 មនោសញ្ចេតនា (Romance)',
  'Flash Marriage': '💍 រៀបការផ្លេកបន្ទោរ (Flash Marriage)',
  'Hidden Identity': '🎭 លាក់អត្តសញ្ញាណ (Hidden Identity)',
};

const dramawave = require('./dramawave');
const netshort = require('./netshort');
const goodshort = require('./goodshort');
const ytdm = require('./ytdm');
const customCms = require('./custom-cms');

const SOURCES = [
  { id: 'hongguo', label: '🔥 HongGuo (红果)', shortLabel: 'HongGuo', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'ytdm', label: '📺 YouTube / DM (រឿងពេញ)', shortLabel: 'YouTube / DM', lang: 'multi', hasCategories: true, hasSearch: true },
  { id: 'dramabox', label: '🎬 DramaBox', shortLabel: 'DramaBox', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'reelshort', label: '🎭 ReelShort', shortLabel: 'ReelShort', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'dramawave', label: '🌊 DramaWave', shortLabel: 'DramaWave', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'netshort', label: '⚡ NetShort', shortLabel: 'NetShort', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'goodshort', label: '✨ GoodShort', shortLabel: 'GoodShort', lang: 'en', hasCategories: true, hasSearch: true },
  { id: 'hema', label: '🦛 Hema (河马)', shortLabel: 'Hema', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'xifan', label: '🍱 Xifan (西饭)', shortLabel: 'Xifan', lang: 'zh', hasCategories: true, hasSearch: true },
  { id: 'social', label: '🌐 Social / Link (TikTok, YT...)', shortLabel: 'Social Video', lang: 'multi', hasCategories: false, hasSearch: false },
];

function getSourcesList() {
  const customRows = customCms.getCustomSources()
    .filter((s) => s.enabled !== false)
    .map((s) => ({
      id: `custom:${s.id}`,
      label: `🧩 ${s.name}`,
      shortLabel: s.name,
      lang: 'multi',
      hasCategories: true,
      hasSearch: true,
      isCustom: true,
    }));
  const social = SOURCES.find((s) => s.id === 'social');
  const core = SOURCES.filter((s) => s.id !== 'social');
  return [...core, ...customRows, ...(social ? [social] : [])];
}

function setCustomSources(list = []) {
  const saved = customCms.setCustomSources(list);
  for (const key of sourceCatalogCache.keys()) {
    if (key.startsWith('custom:')) sourceCatalogCache.delete(key);
  }
  for (const key of sourceGenresCache.keys()) {
    if (key.startsWith('custom:')) sourceGenresCache.delete(key);
  }
  return saved;
}

const sourceGenresCache = new Map();
const sourceCatalogCache = new Map();
const inflightCatalog = new Map();
const GENRE_CACHE_TTL_MS = 15 * 60 * 1000;
const CATALOG_CACHE_TTL_MS = 3 * 60 * 1000;

function stripHtmlText(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim();
}

// ===== DramaBox Hybrid Engine (Android SAPI v4.9.0 HTTP/2 + Webfic + Web SSR) =====
function getDramaBoxPrivateKey() {
  if (!dramaboxPrivateKey) {
    dramaboxPrivateKey = crypto.createPrivateKey({ key: DRAMABOX_RSA_JWK, format: 'jwk' });
  }
  return dramaboxPrivateKey;
}

function signDramaBoxPayload(str) {
  return crypto.sign('RSA-SHA256', Buffer.from(str, 'utf8'), getDramaBoxPrivateKey()).toString('base64');
}

function dramaboxH2Post(host, path, headers, body, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = http2.connect(`https://${host}`, { ciphers: DRAMABOX_TLS_CIPHERS });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { client.destroy(); } catch (_) {}
        reject(new Error('DramaBox SAPI timeout'));
      }
    }, timeoutMs);

    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    const h2Headers = {
      ':method': 'POST',
      ':path': path,
      ':authority': host,
      ':scheme': 'https',
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };

    const req = client.request(h2Headers);
    let status = 0;
    let enc = '';
    const chunks = [];

    req.on('response', (hdrs) => {
      status = Number(hdrs[':status']) || 0;
      enc = String(hdrs['content-encoding'] || '').toLowerCase();
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      let buf = Buffer.concat(chunks);
      try {
        if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
        else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
      } catch (_) {}
      const text = buf.toString('utf8');
      if (status < 200 || status >= 300 || !text.trim().startsWith('{')) {
        return reject(new Error(`DramaBox SAPI HTTP ${status}`));
      }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { client.close(); } catch (_) {}
        reject(err);
      }
    });
    req.write(body);
    req.end();
  });
}

function buildDramaBoxAppHeaders(sess, timestamp, sn, tn = '') {
  return {
    'accept-encoding': 'gzip',
    'active-time': '25000',
    'afid': sess.afid,
    'android-id': sess.androidId,
    'apn': '0',
    'brand': 'Xiaomi',
    'build': 'Build/QQ3A.200805.001',
    'cid': 'DAUAG1064236',
    'content-type': 'application/json; charset=UTF-8',
    'country-code': 'ID',
    'current-language': 'en',
    'device-id': sess.deviceId,
    'device-score': '55',
    'ins': sess.ins,
    'instanceid': sess.instanceId,
    'is_emulator': '0',
    'is_root': '1',
    'is_vpn': '1',
    'language': 'en',
    'lat': '0',
    'local-time': '2026-11-17 13:30:00.000 +0700',
    'locale': 'en_US',
    'mbid': '60000000000',
    'mcc': '510',
    'mchid': 'DAUAG1050238',
    'md': 'V2309A',
    'mf': 'VIVO',
    'nchid': 'DRA1000000',
    'ov': '9',
    'over-flow': 'new-fly',
    'p': '51',
    'package-name': 'com.storymatrix.drama',
    'pline': 'ANDROID',
    'srn': '900x1600',
    'store-source': 'store_google',
    'time-zone': '+0800',
    'tn': tn,
    'tz': '-480',
    'user-agent': DRAMABOX_APP_UA,
    'userid': '359146421',
    'version': '490',
    'vn': '4.9.0',
    'sn': sn,
  };
}

async function getDramaBoxSession(force = false) {
  if (dramaboxCustomToken) {
    if (!force && dramaboxSession && dramaboxSession.isCustom && dramaboxSession.token === dramaboxCustomToken) {
      return dramaboxSession;
    }
    const ts = Date.now();
    dramaboxSession = {
      deviceId: crypto.randomUUID(),
      androidId: '00000000' + crypto.randomBytes(8).toString('hex') + '00000000',
      instanceId: crypto.randomBytes(16).toString('hex'),
      afid: `${ts}-${Math.floor(Math.random() * 9999999999999999)}`,
      ins: String(ts),
      host: DRAMABOX_SAPI_HOSTS[0],
      token: dramaboxCustomToken,
      isCustom: true,
      expiry: Date.now() + 24 * 60 * 60 * 1000,
    };
    return dramaboxSession;
  }
  if (!force && dramaboxSession && dramaboxSession.expiry > Date.now()) {
    return dramaboxSession;
  }
  const ts = Date.now();
  const sess = {
    deviceId: crypto.randomUUID(),
    androidId: '00000000' + crypto.randomBytes(8).toString('hex') + '00000000',
    instanceId: crypto.randomBytes(16).toString('hex'),
    afid: `${ts}-${Math.floor(Math.random() * 9999999999999999)}`,
    ins: String(ts),
  };
  const body = JSON.stringify({ distinctId: null });
  const sn = signDramaBoxPayload(`timestamp=${ts}${body}${sess.deviceId}${sess.androidId}`);
  const headers = buildDramaBoxAppHeaders(sess, ts, sn, '');

  for (const host of DRAMABOX_SAPI_HOSTS) {
    try {
      const data = await dramaboxH2Post(host, `/drama-box/ap001/bootstrap?timestamp=${ts}`, headers, body, 8000);
      const token = data?.data?.user?.token;
      if (token) {
        dramaboxSession = {
          ...sess,
          host,
          token,
          expiry: Date.now() + 6 * 60 * 60 * 1000,
        };
        return dramaboxSession;
      }
    } catch (_) {}
  }
  throw new Error('មិនអាចបង្កើត Token សម្រាប់ DramaBox SAPI បានទេ');
}

async function dramaboxSapiRequest(endpoint, payloadObj = {}, retry = true) {
  const sess = await getDramaBoxSession(false);
  const ts = Date.now();
  const body = JSON.stringify(payloadObj);
  const tn = `Bearer ${sess.token}`;
  const sn = signDramaBoxPayload(`timestamp=${ts}${body}${sess.deviceId}${sess.androidId}${tn}`);
  const headers = buildDramaBoxAppHeaders(sess, ts, sn, tn);

  const hosts = [sess.host, ...DRAMABOX_SAPI_HOSTS.filter((h) => h !== sess.host)];
  for (const host of hosts) {
    try {
      const res = await dramaboxH2Post(host, `${endpoint}?timestamp=${ts}`, headers, body, 9000);
      if (res && res.success === false && retry) {
        await getDramaBoxSession(true);
        return dramaboxSapiRequest(endpoint, payloadObj, false);
      }
      return res;
    } catch (_) {}
  }
  if (retry) {
    await getDramaBoxSession(true);
    return dramaboxSapiRequest(endpoint, payloadObj, false);
  }
  throw new Error('DramaBox SAPI មិនឆ្លើយតបទេ');
}

async function dramaboxWebficBrowse(typeTwoId = 0, pageNo = 1, pageSize = 18) {
  const res = await axios.post(`${DRAMABOX_WEBFIC_URL}/webfic/home/browse`, {
    typeTwoId: Number(typeTwoId) || 0,
    pageNo: Number(pageNo) || 1,
    pageSize: Number(pageSize) || 18,
  }, {
    timeout: 9000,
    headers: {
      'Content-Type': 'application/json',
      pline: 'DRAMABOX',
      language: 'en',
      'User-Agent': DRAMABOX_UA,
    },
  });
  return res.data?.data || {};
}

function parseDramaBoxId(value, episode = false) {
  const raw = String(value || '').trim();
  if (!episode) {
    const urlMatch = raw.match(/dramabox(?:db|app)?\.com\/(?:[a-zA-Z-]+\/)?(?:drama|movie|video)\/(\d{1,24})/i);
    if (urlMatch) {
      return { bookId: urlMatch[1], chapterId: undefined, seriesId: `dramabox:${urlMatch[1]}` };
    }
    if (DRAMABOX_ID_RE.test(raw)) {
      return { bookId: raw, chapterId: undefined, seriesId: `dramabox:${raw}` };
    }
  }
  const parts = raw.split(':');
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
  if (!book) return null;
  const bookId = String(book.bookId || book.id || '');
  const title = stripHtmlText(book.bookName || book.name || book.title || '');
  if (!DRAMABOX_ID_RE.test(bookId) || !title) return null;
  const rawCover = String(book.cover || book.coverWap || book.bookCover || '').split('@')[0];
  const cover = isPublicMediaUrl(rawCover) ? rawCover : '';
  return {
    series_id: `dramabox:${bookId}`,
    series_title: title,
    cover,
    episode_count: Number(book.chapterCount ?? book.totalChapterNum ?? book.totalEpisodes) || 0,
    intro: stripHtmlText(book.introduction || book.synopsis || ''),
    source: 'dramabox',
    url: `${DRAMABOX_ORIGIN}/drama/${bookId}`,
  };
}

function buildDramaBoxGenres(webficTypes = []) {
  const base = [
    { id: 'trending', name: '📈 កំពុងល្បី (Trending)' },
    { id: 'latest', name: '🆕 រឿងថ្មីៗ (Latest)' },
    { id: 'rank', name: '🏆 ចំណាត់ថ្នាក់ (Top Rank)' },
    { id: 'vip', name: '👑 រឿង VIP ពិសេស' },
  ];
  const dynamic = (Array.isArray(webficTypes) ? webficTypes : [])
    .filter((t) => t && t.id && Number(t.id) > 0 && t.name)
    .slice(0, 18)
    .map((t) => ({
      id: String(t.id),
      name: DRAMABOX_KHMER_GENRE_LABELS[t.name] || `🎬 ${t.name}`,
    }));
  return [...base, ...dynamic];
}

async function dramaboxBrowse({ genre = '', page = 1 } = {}) {
  const pg = Math.max(1, Number(page) || 1);
  const g = String(genre || '').trim();

  // 1. SAPI Special Channels (Trending / Latest / VIP / Rank)
  if (['trending', 'latest', 'vip', 'rank'].includes(g)) {
    try {
      let rawBooks = [];
      if (g === 'rank') {
        const rankData = await dramaboxSapiRequest('/drama-box/he001/rank', { rankType: (pg % 3) + 1 });
        rawBooks = rankData?.data?.rankList || [];
      } else {
        const channelMap = {
          trending: { newChannelStyle: 1, isNeedRank: 1, pageNo: pg, index: 0, channelId: 175 },
          latest: { newChannelStyle: 1, isNeedRank: 1, pageNo: pg, index: 1, channelId: 48 },
          vip: { homePageStyle: 0, isNeedRank: 1, pageNo: pg, index: 4, type: 0, channelId: 205 },
        };
        const theaterData = await dramaboxSapiRequest('/drama-box/he001/theater', channelMap[g]);
        const cols = theaterData?.data?.columnVoList || [];
        for (const col of cols) {
          if (Array.isArray(col?.bookList)) rawBooks.push(...col.bookList);
        }
      }
      const seen = new Set();
      const results = rawBooks.map(normalizeDramaBoxBook).filter((b) => {
        if (!b || seen.has(b.series_id)) return false;
        seen.add(b.series_id);
        return true;
      });
      if (results.length > 0) {
        return { success: true, results, page: pg, hasMore: pg < 5, genres: buildDramaBoxGenres() };
      }
    } catch (_) {}
  }

  // 2. Webfic API (supports all typeTwoId categories + fast pagination + genres list)
  const typeTwoId = /^\d+$/.test(g) ? Number(g) : 0;
  try {
    const wf = await dramaboxWebficBrowse(typeTwoId, pg, 18);
    const results = (wf.bookList || []).map(normalizeDramaBoxBook).filter(Boolean);
    const genres = buildDramaBoxGenres(wf.types || []);
    const pages = Number(wf.pages) || 1;
    if (results.length > 0) {
      return { success: true, results, page: pg, hasMore: pg < pages, genres };
    }
  } catch (_) {}

  // 3. Fallback to Web SSR
  const route = typeTwoId > 0 ? `/browse/${typeTwoId}/${pg}` : (pg === 1 ? '/browse' : `/browse/0/${pg}`);
  const props = await dramaboxRequest(route);
  const results = (props.bookList || []).map(normalizeDramaBoxBook).filter(Boolean);
  const pages = Number(props.pages) || 1;
  const genres = buildDramaBoxGenres(props.types || []);
  return { success: true, results, page: pg, hasMore: results.length > 0 && pg < pages, genres };
}

async function dramaboxSearch(keyword, page = 1) {
  const searchValue = String(keyword || '').trim();
  if (!searchValue) return { success: true, results: [], hasMore: false };
  const pg = Math.max(1, Number(page) || 1);

  // Try Native SAPI Search first (higher recall + faster), fallback to Web SSR
  try {
    const sRes = await dramaboxSapiRequest('/drama-box/search/search', {
      searchSource: '搜索按钮',
      pageNo: pg,
      pageSize: 20,
      from: 'search_sug',
      keyword: searchValue,
    });
    const list = (sRes?.data?.searchList || []).map(normalizeDramaBoxBook).filter(Boolean);
    if (list.length > 0) {
      return { success: true, results: list, page: pg, hasMore: Boolean(sRes?.data?.isMore) };
    }
  } catch (_) {}

  const props = await dramaboxRequest('/search', { searchValue, page: pg });
  const results = (props.bookList || []).map(normalizeDramaBoxBook).filter(Boolean);
  const pages = Number(props.totalPage) || 1;
  return { success: true, results, page: pg, hasMore: results.length > 0 && pg < pages };
}

function pickBestDramaBoxCdnVideo(chapter) {
  if (!chapter || !Array.isArray(chapter.cdnList) || !chapter.cdnList.length) return null;
  const cdn = chapter.cdnList.find((c) => c.isDefault === 1) || chapter.cdnList[0];
  const vList = Array.isArray(cdn?.videoPathList) ? cdn.videoPathList : [];
  if (!vList.length) return null;
  const sorted = [...vList].sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0));
  const valid = sorted.filter((v) => v?.videoPath && isPublicMediaUrl(v.videoPath));
  if (!valid.length) return null;
  const best = valid[0];
  const variants = valid.map((v) => ({
    url: String(v.videoPath),
    format: 'mp4',
    codec: 'h264',
    quality: v.quality ? `${v.quality}p` : 'HD',
    source: 'dramabox',
    userAgent: DRAMABOX_UA,
    referer: `${DRAMABOX_ORIGIN}/`,
  }));
  return {
    url: String(best.videoPath),
    quality: best.quality ? `${best.quality}p` : 'HD',
    variants,
  };
}

async function fetchSapiUnlockedChaptersMap(bookId, payChapterNum = 9) {
  const unlockedByIndex = new Map();
  const unlockedById = new Map();
  let bookMeta = null;
  let totalChapters = 0;

  const fetchBatchIndex = async (idx) => {
    const res = await dramaboxSapiRequest('/drama-box/chapterv2/batch/load', {
      boundaryIndex: 0,
      comingPlaySectionId: -1,
      index: idx,
      currencyPlaySourceName: '首页发现_Untukmu_推荐列表',
      rid: '',
      enterReaderChapterIndex: 0,
      loadDirection: 1,
      startUpKey: '10942710-5e9e-48f2-8927-7c387e6f5fac',
      bookId: String(bookId),
      currencyPlaySource: 'discover_175_rec',
      needEndRecommend: 0,
      preLoad: false,
      pullCid: '',
    });
    const d = res?.data;
    if (d && !bookMeta && d.bookName) {
      bookMeta = {
        bookId: d.bookId || bookId,
        bookName: d.bookName,
        cover: d.bookCover,
        chapterCount: d.chapterCount,
        introduction: d.introduction,
        payChapterNum: d.payChapterNum,
      };
      totalChapters = Number(d.chapterCount) || 0;
    }
    const list = Array.isArray(d?.chapterList) ? d.chapterList : [];
    for (const ch of list) {
      const best = pickBestDramaBoxCdnVideo(ch);
      if (best && best.url) {
        const item = {
          chapterId: String(ch.chapterId || ''),
          chapterIndex: Number(ch.chapterIndex),
          name: ch.chapterName,
          duration: Number(ch.duration) || 0,
          url: best.url,
          quality: best.quality,
          variants: best.variants || [],
        };
        if (Number.isFinite(item.chapterIndex)) unlockedByIndex.set(item.chapterIndex, item);
        if (item.chapterId) unlockedById.set(item.chapterId, item);
      }
    }
    return d;
  };

  try {
    const first = await fetchBatchIndex(1);
    const payNum = Number(first?.payChapterNum) || payChapterNum || 9;
    const total = Number(first?.chapterCount) || totalChapters || 0;
    const maxWindowStart = dramaboxCustomToken && total > 0
      ? total
      : Math.max(6, payNum + 6);
    const indices = [];
    for (let i = 6; i <= maxWindowStart; i += 5) {
      indices.push(i);
    }
    if (!indices.includes(maxWindowStart)) indices.push(maxWindowStart);
    await Promise.allSettled(indices.map((idx) => fetchBatchIndex(idx)));
  } catch (_) {}

  return { unlockedByIndex, unlockedById, bookMeta, totalChapters };
}

async function dramaboxFetchEpisodeList(seriesId, options = {}) {
  const id = parseDramaBoxId(seriesId);
  const cached = dramaboxEpisodeCache.get(id.bookId);
  if (!options.force && cached && Date.now() - cached.at < DRAMABOX_EP_CACHE_TTL_MS && cached.episodeListResult) {
    return cached.episodeListResult;
  }

  // Fetch Web SSR (full chapter index list) & SAPI batch/load (1080p + extra unlocked chapters) in parallel
  const [ssrRes, sapiRes] = await Promise.allSettled([
    dramaboxRequest(`/drama/${id.bookId}`, {}, options),
    fetchSapiUnlockedChaptersMap(id.bookId),
  ]);

  const props = ssrRes.status === 'fulfilled' ? ssrRes.value : null;
  const sapiData = sapiRes.status === 'fulfilled' ? sapiRes.value : { unlockedByIndex: new Map(), unlockedById: new Map(), bookMeta: null, totalChapters: 0 };

  const book = normalizeDramaBoxBook(props?.bookInfo || sapiData.bookMeta);
  const ssrChapters = Array.isArray(props?.chapterList) ? props.chapterList : [];

  if (!book || (!ssrChapters.length && !sapiData.unlockedByIndex.size)) {
    throw new Error('DramaBox មិនមានបញ្ជីភាគទេ');
  }

  const streamByChapterId = new Map();
  let episodes = [];

  if (ssrChapters.length > 0) {
    const sorted = [...ssrChapters].sort((a, b) => Number(a.index) - Number(b.index));
    episodes = sorted.map((chapter, idx) => {
      const chId = String(chapter.id);
      const chIdx = Number.isFinite(Number(chapter.index)) ? Number(chapter.index) : idx;
      const sapiMatch = sapiData.unlockedById.get(chId) || sapiData.unlockedByIndex.get(chIdx);
      const ssrUrl = (chapter.unlock === true && chapter.mp4 && isPublicMediaUrl(chapter.mp4)) ? String(chapter.mp4) : '';
      const bestUrl = sapiMatch?.url || ssrUrl || '';
      const bestQuality = sapiMatch?.quality || (ssrUrl ? '720p' : '');

      if (bestUrl) {
        streamByChapterId.set(chId, {
          url: bestUrl,
          quality: bestQuality || 'HD',
          index: chIdx + 1,
          variants: sapiMatch?.variants?.length ? sapiMatch.variants : [{ url: bestUrl, format: 'mp4', codec: 'h264', quality: bestQuality || '720p', source: 'dramabox' }],
        });
      }

      return {
        vid: `dramabox:${id.bookId}:${chId}`,
        vid_index: chIdx + 1,
        title: stripHtmlText(chapter.name || sapiMatch?.name) || `ភាគទី ${chIdx + 1}`,
        series_id: `dramabox:${id.bookId}`,
        series_title: book.series_title,
        cover: book.cover,
        duration: Number(chapter.duration) / 1000 || Number(sapiMatch?.duration) / 1000 || 0,
        locked: !bestUrl,
        quality: bestQuality || undefined,
        source: 'dramabox',
      };
    });
  } else {
    const sortedSapi = Array.from(sapiData.unlockedByIndex.values()).sort((a, b) => a.chapterIndex - b.chapterIndex);
    episodes = sortedSapi.map((ch) => {
      streamByChapterId.set(ch.chapterId, { url: ch.url, quality: ch.quality || '1080p', index: ch.chapterIndex + 1, variants: ch.variants || [] });
      return {
        vid: `dramabox:${id.bookId}:${ch.chapterId}`,
        vid_index: ch.chapterIndex + 1,
        title: stripHtmlText(ch.name) || `ភាគទី ${ch.chapterIndex + 1}`,
        series_id: `dramabox:${id.bookId}`,
        series_title: book.series_title,
        cover: book.cover,
        duration: Number(ch.duration) / 1000 || 0,
        locked: false,
        quality: ch.quality || '1080p',
        source: 'dramabox',
      };
    });
  }

  const episodeListResult = {
    ...book,
    series_id: `dramabox:${id.bookId}`,
    total: episodes.length,
    episodes,
  };

  dramaboxEpisodeCache.set(id.bookId, {
    at: Date.now(),
    episodeListResult,
    streamByChapterId,
  });

  return episodeListResult;
}

async function dramaboxFetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseDramaBoxId(vid, true);
    if (seriesId) {
      const normalizedSid = resolveDramaUrlOrId(seriesId);
      if (normalizedSid && normalizedSid !== id.seriesId && normalizedSid !== id.bookId && `dramabox:${normalizedSid}` !== id.seriesId) {
        throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
      }
    }

    // 1. Check in-memory episode cache first (0ms O(1) lookup for batch downloads!)
    let cached = dramaboxEpisodeCache.get(id.bookId);
    if (!cached || Date.now() - cached.at >= DRAMABOX_EP_CACHE_TTL_MS) {
      await dramaboxFetchEpisodeList(id.seriesId).catch(() => null);
      cached = dramaboxEpisodeCache.get(id.bookId);
    }

    const hit = cached?.streamByChapterId?.get(id.chapterId);
    if (hit && hit.url) {
      return {
        url: hit.url,
        format: /\.m3u8(\?|$)/i.test(hit.url) ? 'hls' : 'mp4',
        source: 'dramabox',
        codec: 'h264',
        quality: hit.quality || '1080p',
        variants: Array.isArray(hit.variants) ? hit.variants : undefined,
        spadeA: null,
        userAgent: DRAMABOX_UA,
        referer: `${DRAMABOX_ORIGIN}/`,
      };
    }

    const epMeta = cached?.episodeListResult?.episodes?.find((e) => e.vid === vid);
    const epNum = epMeta?.vid_index || 0;
    return {
      url: null,
      locked: true,
      source: 'dramabox',
      error: `ភាគ ${epNum || id.chapterId} ជាប់សោ VIP លើ DramaBox (អាចទាញយកបានតែភាគឥតគិតថ្លៃ + ភាគដោះសោ SAPI ប៉ុណ្ណោះ)`,
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
  if (s.startsWith('dramawave:')) return 'dramawave';
  if (s.startsWith('netshort:')) return 'netshort';
  if (s.startsWith('goodshort:')) return 'goodshort';
  if (s.startsWith('ytdm:')) return 'ytdm';
  if (s.startsWith('custom:')) {
    const parts = s.split(':');
    if (parts.length >= 2 && parts[1]) return `custom:${parts[1].toLowerCase()}`;
  }
  if (s.startsWith('hema:')) return 'hema';
  if (s.startsWith('xifan:')) return 'xifan';
  if (/^https?:\/\/(?:www\.)?dramabox(?:db|app)?\.com\//i.test(s)) return 'dramabox';
  if (/^https?:\/\/(?:www\.)?reelshort\.com\/(?:movie|episodes)\//i.test(s)) return 'reelshort';
  if (/^https?:\/\/(?:[a-z0-9-]+\.)*mydramawave\.com\//i.test(s)) return 'dramawave';
  if (/^https?:\/\/(?:[a-z0-9-]+\.)*netshort\.com\//i.test(s)) return 'netshort';
  if (/^https?:\/\/(?:[a-z0-9-]+\.)*goodshort\.com\//i.test(s)) return 'goodshort';
  return 'hongguo';
}

function resolveDramaUrlOrId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.startsWith('dramabox:') || /^https?:\/\/(?:www\.)?dramabox(?:db|app)?\.com\//i.test(s)) {
    const m = s.startsWith('dramabox:')
      ? s.split(':')[1]
      : s.match(/\/(?:drama|movie|video|episodes?)\/(\d{1,24})/i)?.[1];
    return m && DRAMABOX_ID_RE.test(m) ? `dramabox:${m}` : null;
  }
  const adapterMatchers = [
    { prefix: 'reelshort:', urlRe: /^https?:\/\/(?:www\.)?reelshort\.com\//i, adapter: reelshort },
    { prefix: 'dramawave:', urlRe: /^https?:\/\/(?:[a-z0-9-]+\.)*mydramawave\.com\//i, adapter: dramawave },
    { prefix: 'netshort:', urlRe: /^https?:\/\/(?:[a-z0-9-]+\.)*netshort\.com\//i, adapter: netshort },
    { prefix: 'goodshort:', urlRe: /^https?:\/\/(?:[a-z0-9-]+\.)*goodshort\.com\//i, adapter: goodshort },
    { prefix: 'ytdm:', urlRe: null, adapter: ytdm },
    { prefix: 'custom:', urlRe: null, adapter: customCms },
  ];
  for (const m of adapterMatchers) {
    if (s.startsWith(m.prefix) || (m.urlRe && m.urlRe.test(s))) {
      try { return m.adapter.resolveSeriesId(s); } catch (_) { return null; }
    }
  }
  if (s.startsWith('hema:')) return s;
  if (s.startsWith('xifan:')) return s;
  if (DRAMABOX_ID_RE.test(s)) return s;
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

const REELSHORT_THEME_QUERIES = ['ceo', 'billionaire', 'revenge', 'love', 'wife', 'alpha', 'marriage'];
let reelshortCachedGenres = [];

async function reelshortBrowseExpanded({ genre = '', page = 1 } = {}) {
  const pg = Math.max(1, Number(page) || 1);
  if (genre) {
    if (pg > 1) return { success: true, results: [], page: pg, hasMore: false, genres: reelshortCachedGenres };
    return reelshort.browseList({ genre, page: 1 });
  }
  if (pg === 1) {
    const p1 = await reelshort.browseList({ genre: '', page: 1 });
    if (Array.isArray(p1?.genres) && p1.genres.length) {
      reelshortCachedGenres = p1.genres;
    }
    if (!p1 || p1.success === false) return p1;
    const totalExtra = Math.max(0, reelshortCachedGenres.length - 1) + REELSHORT_THEME_QUERIES.length;
    return { ...p1, hasMore: totalExtra > 0 };
  }
  const shelfIdx = pg - 1;
  const totalSlots = Math.max(0, reelshortCachedGenres.length - 1) + REELSHORT_THEME_QUERIES.length;
  if (shelfIdx < reelshortCachedGenres.length) {
    const targetShelf = reelshortCachedGenres[shelfIdx];
    const r = await reelshort.browseList({ genre: targetShelf.slug, page: 1 });
    return {
      ...r,
      page: pg,
      genres: reelshortCachedGenres,
      hasMore: pg <= totalSlots && Array.isArray(r?.results) && r.results.length > 0,
    };
  }
  const kwIdx = shelfIdx - reelshortCachedGenres.length;
  if (kwIdx >= 0 && kwIdx < REELSHORT_THEME_QUERIES.length) {
    const sr = await reelshort.search(REELSHORT_THEME_QUERIES[kwIdx], 1);
    return {
      ...sr,
      page: pg,
      genres: reelshortCachedGenres,
      hasMore: (kwIdx + 1) < REELSHORT_THEME_QUERIES.length && Array.isArray(sr?.results) && sr.results.length > 0,
    };
  }
  return { success: true, results: [], page: pg, hasMore: false, genres: reelshortCachedGenres };
}

function resolveYtdmUrl(input) {
  try {
    return ytdm.resolveSeriesId(input);
  } catch (_) {
    return null;
  }
}

function getSourceAdapter(sourceId) {
  if (typeof sourceId === 'string' && sourceId.startsWith('custom:')) {
    return {
      browseList: (opts = {}) => customCms.browseList({ ...opts, sourceId }),
      search: (kw, pg) => customCms.search(sourceId, kw, pg),
      fetchEpisodeList: (sid, opts) => customCms.fetchEpisodeList(sid, opts),
      fetchPlayUrlSingle: (vid, sid) => customCms.fetchPlayUrlSingle(vid, sid),
    };
  }
  switch (sourceId) {
    case 'ytdm':
      return ytdm;
    case 'dramabox':
      return {
        browseList: dramaboxBrowse,
        search: dramaboxSearch,
        fetchEpisodeList: dramaboxFetchEpisodeList,
        fetchPlayUrlSingle: dramaboxFetchPlayUrlSingle,
      };
    case 'reelshort':
      return {
        ...reelshort,
        browseList: reelshortBrowseExpanded,
      };
    case 'dramawave':
      return dramawave;
    case 'netshort':
      return netshort;
    case 'goodshort':
      return goodshort;
    case 'hema':
      return hema;
    case 'xifan':
      return xifan;
    default:
      return {
        ...hongguo,
        browseList: (opts) => catalog.browseList(opts),
        search: (kw, pg) => searchHongguo(kw, pg),
      };
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
  const gSlug = genre ? String(genre) : '';
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
    const categories = sourceGenresCache.get(sourceId)?.list || [{ id: '', name: '🔥 ពេញនិយម' }];

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
  const cleanVid = (typeof vid === 'object' && vid !== null) ? String(vid.vid || vid.id || '') : String(vid || '');
  const cleanSid = (typeof seriesId === 'object' && seriesId !== null) ? String(seriesId.seriesId || seriesId.id || '') : String(seriesId || '');
  const src = detectSourceFromId(cleanSid || cleanVid);
  if (src === 'hongguo') {
    return hongguo.fetchPlayUrlSingle(cleanVid, cleanSid, options);
  }
  const adapter = getSourceAdapter(src);
  return adapter.fetchPlayUrlSingle(cleanVid, cleanSid);
}

function formatClockDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function parseClockDurationToSeconds(text = '') {
  const parts = String(text || '').trim().split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function searchDailymotionFullMovies(title) {
  const q = String(title || '').replace(/\([^)]*\)/g, '').trim();
  if (!q) return [];
  const res = await axios.get('https://api.dailymotion.com/videos', {
    params: {
      search: q,
      fields: 'id,title,duration,thumbnail_480_url,url,views_total,owner.screenname',
      limit: 8,
    },
    timeout: 7000,
  });
  const list = Array.isArray(res.data?.list) ? res.data.list : [];
  return list
    .filter((v) => v && v.id && v.url && Number(v.duration) >= 300)
    .map((v) => ({
      id: `dm:${v.id}`,
      title: stripHtmlText(v.title || q),
      url: String(v.url),
      cover: v.thumbnail_480_url || '',
      durationSec: Number(v.duration) || 0,
      durationText: formatClockDuration(v.duration),
      channel: v['owner.screenname'] || 'Dailymotion',
      platform: 'Dailymotion',
      platformIcon: '🎬',
    }));
}

async function searchYouTubeFullMovies(title) {
  const q = `${String(title || '').replace(/\([^)]*\)/g, '').trim()} full drama movie`;
  if (!q.trim()) return [];
  const res = await axios.get('https://www.youtube.com/results', {
    params: { search_query: q },
    headers: {
      'User-Agent': DRAMABOX_UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 7500,
    responseType: 'text',
  });
  const match = String(res.data || '').match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!match) return [];
  const data = JSON.parse(match[1]);
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const out = [];
  for (const sec of sections) {
    const items = sec?.itemSectionRenderer?.contents || [];
    for (const entry of items) {
      const v = entry?.videoRenderer;
      if (!v || !v.videoId) continue;
      const durText = v.lengthText?.simpleText || '';
      const durSec = parseClockDurationToSeconds(durText);
      if (durSec > 0 && durSec < 300) continue; // skip shorts/trailers under 5 min
      const titleText = (v.title?.runs || []).map((r) => r.text).join('') || v.title?.simpleText || '';
      if (!titleText) continue;
      out.push({
        id: `yt:${v.videoId}`,
        title: stripHtmlText(titleText),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        cover: v.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
        durationSec: durSec,
        durationText: durText || formatClockDuration(durSec),
        channel: v.ownerText?.runs?.[0]?.text || 'YouTube',
        platform: 'YouTube',
        platformIcon: '▶️',
      });
      if (out.length >= 6) break;
    }
    if (out.length >= 6) break;
  }
  return out;
}

async function findFullMovieMirrors(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  const [dmRes, ytRes] = await Promise.allSettled([
    searchDailymotionFullMovies(clean),
    searchYouTubeFullMovies(clean),
  ]);
  const dmList = dmRes.status === 'fulfilled' ? dmRes.value : [];
  const ytList = ytRes.status === 'fulfilled' ? ytRes.value : [];
  const combined = [...dmList, ...ytList];
  // Prioritize full-length movies (20m - 3h) and titles containing FULL
  combined.sort((a, b) => {
    const aFull = /\bfull\b/i.test(a.title) ? 1 : 0;
    const bFull = /\bfull\b/i.test(b.title) ? 1 : 0;
    if (bFull !== aFull) return bFull - aFull;
    const aLong = a.durationSec >= 1200 ? 1 : 0;
    const bLong = b.durationSec >= 1200 ? 1 : 0;
    if (bLong !== aLong) return bLong - aLong;
    return (b.durationSec || 0) - (a.durationSec || 0);
  });
  return combined.slice(0, 8);
}

module.exports = {
  SOURCES,
  getSourcesList,
  setCustomSources,
  getCustomSources: () => customCms.getCustomSources(),
  testCustomSource: (draft) => customCms.testCustomSource(draft),
  validateCustomSource: (draft) => customCms.validateSource(draft),
  endpointKey: (url) => customCms.endpointKey(url),
  batchTestCustomSources: (opts = {}) => customCms.batchTestSources({
    ...opts,
    existingSources: customCms.getCustomSources(),
  }),
  detectSourceFromId,
  resolveDramaUrlOrId,
  resolveYtdmUrl,
  getSourceCategories,
  browseSourceCatalog,
  searchSource,
  fetchEpisodeListUnified,
  fetchPlayUrlUnified,
  normalizeCatalogItem,
  setCustomDramaBoxToken,
  getCustomDramaBoxTokenStatus,
  findFullMovieMirrors,
};

