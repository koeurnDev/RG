const crypto = require('crypto');
const axios = require('axios');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');

const ORIGIN = 'https://netshort.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID_RE = /^\d{7,20}$/;

let cachedConfig = null;
let cachedConfigAt = 0;
let cachedHomeSnapshot = null;
const detailCache = new Map();

function plainText(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim();
}

function safeHttpsUrl(v) {
  try {
    const u = new URL(String(v || '').trim(), ORIGIN);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && isPublicMediaUrl(u.href) ? u.href : '';
  } catch (_) {
    return '';
  }
}

function parseId(value, episode = false) {
  const parts = String(value || '').trim().split(':');
  if (parts[0] !== 'netshort') throw new Error('NetShort ID មិនត្រឹមត្រូវ');
  if (!episode && parts.length === 2 && ID_RE.test(parts[1])) {
    return { dramaId: parts[1], seriesId: `netshort:${parts[1]}` };
  }
  if (episode && parts.length === 4 && ID_RE.test(parts[1]) && ID_RE.test(parts[2]) && /^\d{1,5}$/.test(parts[3])) {
    return { dramaId: parts[1], chapterId: parts[2], episodeNo: Number(parts[3]), seriesId: `netshort:${parts[1]}` };
  }
  throw new Error('NetShort ID មិនត្រឹមត្រូវ');
}

function resolveSeriesId(input) {
  const s = String(input || '').trim();
  if (s.startsWith('netshort:')) return parseId(s).seriesId;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new Error('Link NetShort មិនត្រឹមត្រូវ');
  }
  if (!/(?:^|\.)netshort\.com$/i.test(u.hostname)) throw new Error('Link មិនមែនជា NetShort ទេ');
  const m = u.pathname.match(/(\d{7,20})(?:-ep-\d+)?\/?$/) || u.pathname.match(/\/(\d{7,20})(?:\/|$)/);
  if (!m) throw new Error('មិនអាចរកឃើញ NetShort Drama ID ពី Link នេះទេ');
  return `netshort:${m[1]}`;
}

async function loadConfig(force = false) {
  if (!force && cachedConfig && Date.now() - cachedConfigAt < 30 * 60 * 1000) {
    return cachedConfig;
  }
  const html = String((await axios.get(`${ORIGIN}/`, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000, responseType: 'text' })).data || '');
  const candidates = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /\/chunks\/\d+-/.test(u))
    .sort((a, b) => (a.includes('/8000-') ? 0 : 1) - (b.includes('/8000-') ? 0 : 1));

  for (const rel of candidates.slice(0, 12)) {
    const jsUrl = new URL(rel, ORIGIN).href;
    const js = String((await axios.get(jsUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: 9000, responseType: 'text' })).data || '');
    const pubRaw = js.match(/setPublicKey\("(.*?)"\)/)?.[1];
    const privRaw = js.match(/setPrivateKey\("(.*?)"\)/)?.[1];
    const aesKey = js.match(/return"([A-Za-z0-9]{32})"\}\)\(\)/)?.[1];
    if (pubRaw && privRaw && aesKey) {
      cachedConfig = {
        publicKey: JSON.parse(`"${pubRaw}"`),
        privateKey: JSON.parse(`"${privRaw}"`),
        key: Buffer.from(aesKey, 'utf8'),
      };
      cachedConfigAt = Date.now();
      return cachedConfig;
    }
  }
  throw new Error('NetShort browser config បានផ្លាស់ប្តូរ');
}

function aesEcbCipherAlgo(keyBuf) {
  if (keyBuf.length === 16) return 'aes-128-ecb';
  if (keyBuf.length === 24) return 'aes-192-ecb';
  return 'aes-256-ecb';
}

async function apiRequest(apiPath, bodyObj = {}, language = 'en_US') {
  const cfg = await loadConfig(false);
  const encryptedKey = crypto.publicEncrypt(
    { key: cfg.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cfg.key.toString('base64'), 'utf8')
  ).toString('base64');

  const cipher = crypto.createCipheriv(aesEcbCipherAlgo(cfg.key), cfg.key, null);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(bodyObj), 'utf8')),
    cipher.final(),
  ]).toString('base64');

  const res = await axios.post(`${ORIGIN}/prod-web-api${apiPath}`, ciphertext, {
    headers: {
      'Content-Language': language,
      'Content-Type': 'application/json;charset=utf-8',
      OS: '4',
      canary: 'v1',
      version: '1.2.0',
      'encrypt-key': encryptedKey,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': USER_AGENT,
    },
    timeout: 12000,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
  });

  let parsed;
  try {
    parsed = JSON.parse(res.data);
  } catch (_) {
    const encRespKey = res.headers['encrypt-key'];
    if (!encRespKey) throw new Error(`NetShort HTTP ${res.status}: គ្មាន encrypt-key`);
    const rawRespKey = crypto.privateDecrypt(
      { key: cfg.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(encRespKey), 'base64')
    );
    const respKey = Buffer.from(rawRespKey.toString('utf8'), 'base64');
    const decipher = crypto.createDecipheriv(aesEcbCipherAlgo(respKey), respKey, null);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(String(res.data || '').trim(), 'base64')),
      decipher.final(),
    ]).toString('utf8');
    parsed = JSON.parse(plain);
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('NetShort response មិនត្រឹមត្រូវ');
  if (parsed.code !== 200) throw new Error(plainText(parsed.msg) || `NetShort API error (${parsed.code})`);
  return parsed.data;
}

function normalizeCard(item) {
  const id = String(item?.shortPlayId || '').trim();
  if (!ID_RE.test(id)) return null;
  const title = plainText(item.shortPlayNameNoHL || item.shortPlayName);
  if (!title) return null;
  return {
    series_id: `netshort:${id}`,
    series_title: title,
    cover: safeHttpsUrl(item.shortPlayCover),
    description: plainText(item.shotIntroduce),
    episode_count: Number(item.totalEpisode) || 0,
    source: 'netshort',
    url: item.shortPlayNameUrl ? new URL(item.shortPlayNameUrl, ORIGIN).href : `${ORIGIN}`,
  };
}

function parseJsonValueAt(str, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const openChar = str[startIdx];
  const closeChar = openChar === '[' ? ']' : '}';
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) return JSON.parse(str.slice(startIdx, i + 1));
    }
  }
  return null;
}

async function loadHomeSnapshot(force = false) {
  if (!force && cachedHomeSnapshot && Date.now() - cachedHomeSnapshot.at < 5 * 60 * 1000) {
    return cachedHomeSnapshot;
  }
  const [carousel, html] = await Promise.all([
    apiRequest('/web/v5/short_play/load_carousel_chartV5', {}).catch(() => []),
    axios.get(`${ORIGIN}/`, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000, responseType: 'text' }).then((r) => String(r.data || '')),
  ]);

  let stream = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(/g)) {
    const start = m.index + m[0].length;
    if (html[start] !== '[') continue;
    try {
      const arr = parseJsonValueAt(html, start);
      if (Array.isArray(arr) && typeof arr[1] === 'string') stream += arr[1];
    } catch (_) {}
  }

  const marker = '"videoListGroup":';
  const idx = stream.indexOf(marker);
  let groups = [];
  if (idx >= 0) {
    const valStart = stream.indexOf('[', idx + marker.length);
    if (valStart >= 0) groups = parseJsonValueAt(stream, valStart) || [];
  }

  const carouselItems = (Array.isArray(carousel) ? carousel : []).map(normalizeCard).filter(Boolean);
  const groupItems = [];
  const genres = [];
  groups.forEach((g, gi) => {
    const gName = plainText(g?.groupName);
    const items = (Array.isArray(g?.data) ? g.data : []).map(normalizeCard).filter(Boolean);
    if (gName && items.length) {
      genres.push({ slug: `grp-${gi}`, label: gName, items });
      groupItems.push(...items);
    }
  });

  const seen = new Set();
  const all = [];
  for (const item of [...carouselItems, ...groupItems]) {
    if (!seen.has(item.series_id)) {
      seen.add(item.series_id);
      all.push(item);
    }
  }

  cachedHomeSnapshot = { at: Date.now(), all, genres };
  return cachedHomeSnapshot;
}

async function browseList({ genre = '', page = 1 } = {}) {
  try {
    const pg = Math.max(1, Number(page) || 1);
    const snap = await loadHomeSnapshot(false);
    const selected = genre ? snap.genres.find((g) => g.slug === genre) : null;
    const pool = selected ? selected.items : snap.all;
    const pageSize = 24;
    const offset = (pg - 1) * pageSize;
    const results = pool.slice(offset, offset + pageSize);
    return {
      success: true,
      results,
      page: pg,
      hasMore: offset + pageSize < pool.length,
      genres: snap.genres.map(({ slug, label }) => ({ slug, label })),
      pageTitle: 'NetShort',
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
    const raw = await apiRequest('/web/short_play/search/keyword/seo', {
      queryKeyword: kw,
      pageQuery: { pageNum: pg, pageSize: 10 },
    });
    const rows = Array.isArray(raw?.list) ? raw.list : [];
    const results = rows.map(normalizeCard).filter(Boolean);
    return {
      success: true,
      results,
      page: pg,
      hasMore: rows.length >= 10 && results.length > 0,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getRawDetail(dramaId, force = false) {
  const cached = detailCache.get(dramaId);
  if (!force && cached && Date.now() - cached.at < 30 * 1000) return cached.raw;
  const raw = await apiRequest('/web/v4/short_play/detail_info/cascade_label', {
    type: 'episode',
    language: 'en',
    shortPlayId: dramaId,
  });
  if (!raw || String(raw.shortPlayId) !== dramaId || !Array.isArray(raw.videoEpisodeInfos)) {
    throw new Error('មិនអាចទាញព័ត៌មានរឿងពី NetShort បានទេ');
  }
  detailCache.set(dramaId, { at: Date.now(), raw });
  return raw;
}

async function fetchEpisodeList(seriesId, options = {}) {
  const { dramaId } = parseId(seriesId);
  const raw = await getRawDetail(dramaId, options.force === true);
  const title = plainText(raw.shortPlayNameNoHL || raw.shortPlayName) || `NetShort_${dramaId}`;
  const cover = safeHttpsUrl(raw.shortPlayCover);
  const episodes = raw.videoEpisodeInfos
    .filter((ep) => ep && ID_RE.test(String(ep.episodeId || '')))
    .map((ep, idx) => {
      const epNo = Number(ep.episodeNo) || (idx + 1);
      return {
        vid: `netshort:${dramaId}:${ep.episodeId}:${epNo}`,
        vid_index: epNo,
        title: `EP ${epNo}`,
        series_id: `netshort:${dramaId}`,
        series_title: title,
        cover,
        locked: ep.isLock !== false,
        source: 'netshort',
      };
    })
    .sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('មិនមានបញ្ជីភាគសម្រាប់រឿង NetShort នេះទេ');
  return {
    series_id: `netshort:${dramaId}`,
    series_title: title,
    cover,
    intro: plainText(raw.shotIntroduce),
    total: episodes.length,
    episodes,
    source: 'netshort',
  };
}

async function fetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseId(vid, true);
    if (seriesId && parseId(seriesId).seriesId !== id.seriesId) {
      throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
    }
    const raw = await apiRequest('/web/v4/short_play/episode_info', {
      shortPlayId: id.dramaId,
      episodeNo: id.episodeNo,
    });
    if (!raw || String(raw.episodeId) !== id.chapterId) {
      throw new Error('NetShort បញ្ជូនទិន្នន័យភាគមិនត្រូវគ្នា');
    }
    if (raw.isLock !== false) {
      return { url: null, locked: true, source: 'netshort', error: `ភាគ ${id.episodeNo} ជាប់សោ VIP លើ NetShort` };
    }
    const mediaUrl = safeHttpsUrl(raw.playVoucher);
    if (!mediaUrl) throw new Error('NetShort មិនបានផ្ដល់ Link វីដេអូសម្រាប់ភាគនេះទេ');
    const format = /\.m3u8(\?|$)/i.test(mediaUrl) ? 'hls' : 'mp4';
    return {
      url: mediaUrl,
      format,
      source: 'netshort',
      spadeA: null,
      codec: '',
      vid,
      userAgent: USER_AGENT,
      referer: `${ORIGIN}/`,
    };
  } catch (err) {
    return { url: null, source: 'netshort', spadeA: null, codec: null, error: err.message };
  }
}

module.exports = {
  resolveSeriesId,
  browseList,
  search,
  fetchEpisodeList,
  fetchPlayUrlSingle,
};
