const crypto = require('crypto');
const axios = require('axios');
const { isPublicMediaUrl, webMediaRequestOptions } = require('../hongguo-drama/src/native/web-media-guard');

const UUID_RE = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ID_RE = /^\d{1,30}$/;
const MAX_BATCH_CANDIDATES = 50;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let customSourcesRegistry = [];

function plainText(v) {
  return typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : '';
}

function normalizeCmsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096 || !isPublicMediaUrl(rawUrl)) {
    throw new Error('Link ត្រូវតែជា Public HTTP/HTTPS URL');
  }
  const url = new URL(rawUrl);
  if (url.pathname === '/') {
    url.pathname = '/api.php/provide/vod/';
  } else if (/\/at\/xml\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/at\/xml\/?$/i, '/');
  }
  url.hash = '';
  return url;
}

function endpointKey(rawUrl) {
  try {
    const url = normalizeCmsUrl(rawUrl);
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch (_) {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

function validateSource(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('ទម្រង់ប្រភព CMS មិនត្រឹមត្រូវ');
  const name = plainText(draft.name);
  if (!name || name.length > 80) throw new Error('សូមដាក់ឈ្មោះប្រភព (1-80 តួអក្សរ)');
  if (draft.id != null && !UUID_RE.test(String(draft.id))) throw new Error('លេខសម្គាល់ប្រភពមិនត្រឹមត្រូវ');
  const url = normalizeCmsUrl(draft.url);
  return {
    id: draft.id ? String(draft.id).toLowerCase() : crypto.randomUUID().toLowerCase(),
    name,
    url: url.href,
    enabled: draft.enabled !== false,
  };
}

function setCustomSources(list = []) {
  const valid = [];
  const seen = new Set();
  for (const item of (Array.isArray(list) ? list : [])) {
    try {
      const normalized = validateSource(item);
      if (!seen.has(normalized.id)) {
        seen.add(normalized.id);
        valid.push(normalized);
      }
    } catch (_) {}
  }
  customSourcesRegistry = valid;
  return valid;
}

function getCustomSources() {
  return customSourcesRegistry.map((s) => ({ ...s }));
}

function parseSourceUuid(value) {
  const parts = String(value || '').split(':');
  const id = parts[0] === 'custom' ? parts[1] : parts[0];
  if (!UUID_RE.test(id || '')) throw new Error('Custom source ID មិនត្រឹមត្រូវ');
  return id.toLowerCase();
}

function assertEnabled(value) {
  const id = parseSourceUuid(value);
  const src = customSourcesRegistry.find((item) => item.id === id);
  if (!src || src.enabled !== true) throw new Error('ប្រភពផ្ទាល់ខ្លួននេះត្រូវបានបិទ ឬលុបហើយ');
  return src;
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'custom' || parts.length !== (episode ? 5 : 3) || !UUID_RE.test(parts[1]) || !ID_RE.test(parts[2])
    || (episode && !parts.slice(3).every((p) => /^\d{1,5}$/.test(p)))) {
    throw new Error('លេខកូដរឿង Custom CMS មិនត្រឹមត្រូវ');
  }
  return {
    id: parts[1].toLowerCase(),
    vodId: parts[2],
    seriesId: `custom:${parts[1].toLowerCase()}:${parts[2]}`,
    line: Number(parts[3]),
    episode: Number(parts[4]),
  };
}

function resolveSeriesId(input) {
  return parseId(input, false).seriesId;
}

async function cmsRequest(source, params = {}, options = {}) {
  const url = new URL(source.url);
  for (const key of ['ac', 'pg', 't', 'wd', 'ids', 'at']) url.searchParams.delete(key);
  for (const [k, v] of Object.entries({ ac: 'detail', at: 'json', ...params })) {
    url.searchParams.set(k, String(v));
  }
  const guard = webMediaRequestOptions(url.href);
  const timeout = Math.max(2000, Math.min(20000, Number(options.timeoutMs) || 12000));
  const res = await axios.get(url.href, {
    ...guard,
    adapter: 'http',
    timeout,
    maxContentLength: 8 * 1024 * 1024,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  let data;
  try {
    data = JSON.parse(res.data);
  } catch (_) {
    throw new Error('ប្រភព CMS មិនបានត្រឡប់ JSON ត្រឹមត្រូវទេ');
  }
  if (!data || Number(data.code) !== 1 || !Array.isArray(data.list)) {
    throw new Error('ទិន្នន័យ AppleCMS/MacCMS មិនត្រឹមត្រូវ');
  }
  return data;
}

function isLocked(item) {
  return item.locked === true || Number(item.vod_points_play) > 0 || Number(item.vod_points) > 0
    || Boolean(String(item.vod_pwd_play || item.vod_pwd || '').trim());
}

function normalizeItem(item, source) {
  if (!item || !ID_RE.test(String(item.vod_id)) || !plainText(item.vod_name)) return null;
  return {
    series_id: `custom:${source.id}:${item.vod_id}`,
    series_title: plainText(item.vod_name),
    cover: isPublicMediaUrl(item.vod_pic) ? item.vod_pic : '',
    episode_count: Number(item.vod_total) || 0,
    intro: plainText(item.vod_content),
    tags: plainText(item.type_name) ? [plainText(item.type_name)] : [],
    source: `custom:${source.id}`,
    locked: isLocked(item),
  };
}

function formatPageResult(data, source, page) {
  const seen = new Set();
  const results = data.list.map((item) => normalizeItem(item, source)).filter((item) => {
    if (!item || seen.has(item.series_id)) return false;
    seen.add(item.series_id);
    return true;
  });
  const totalPages = Math.max(0, Number.parseInt(data.pagecount, 10) || 0);
  const endpoint = new URL(source.url);
  return {
    success: true,
    results,
    page,
    total: Math.max(0, Number.parseInt(data.total, 10) || 0),
    totalPages,
    hasMore: results.length > 0 && page < totalPages,
    genres: (Array.isArray(data.class) ? data.class : []).slice(0, 500)
      .filter((c) => ID_RE.test(String(c?.type_id)) && plainText(c.type_name))
      .map((c) => ({ slug: String(c.type_id), label: plainText(c.type_name) })),
    pageTitle: source.name,
    sourceUrl: endpoint.origin + endpoint.pathname,
  };
}

async function browseList({ sourceId, genre = '', page = 1 } = {}) {
  try {
    const source = assertEnabled(sourceId);
    const pg = Math.max(1, Number(page) || 1);
    if (genre && !ID_RE.test(String(genre))) throw new Error('ប្រភេទមិនត្រឹមត្រូវ');
    const data = await cmsRequest(source, { pg, ...(genre ? { t: genre } : {}) });
    return formatPageResult(data, source, pg);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function search(sourceId, keyword, page = 1) {
  try {
    const source = assertEnabled(sourceId);
    const pg = Math.max(1, Number(page) || 1);
    const wd = plainText(keyword);
    if (!wd) throw new Error('សូមបញ្ចូលពាក្យស្វែងរក');
    const data = await cmsRequest(source, { wd, pg });
    return formatPageResult(data, source, pg);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function episodeKey(title) {
  const m = title.match(/^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/);
  return m ? `number:${Number(m[1])}` : title;
}

function extractMediaLines(item) {
  const names = String(item.vod_play_from || '').split('$$$');
  return String(item.vod_play_url || '').split('$$$').slice(0, 32).map((line, lineIndex) => ({
    line: lineIndex,
    name: plainText(names[lineIndex]),
    episodes: line.split('#').slice(0, 10000).map((entry, episodeIndex) => {
      const split = entry.indexOf('$');
      if (split < 1) return null;
      const title = plainText(entry.slice(0, split));
      const value = entry.slice(split + 1).trim();
      if (!title || !isPublicMediaUrl(value)) return null;
      const u = new URL(value);
      const ext = u.pathname.match(/\.(mp4|m3u8)$/i)?.[1]?.toLowerCase();
      if (!ext) return null;
      return {
        title,
        key: episodeKey(title),
        url: u.href,
        format: ext === 'm3u8' ? 'hls' : 'mp4',
        line: lineIndex,
        episode: episodeIndex,
      };
    }).filter(Boolean),
  })).filter((l) => l.episodes.length > 0);
}

async function fetchDetail(seriesId) {
  const id = parseId(seriesId);
  const source = assertEnabled(id.id);
  const data = await cmsRequest(source, { ids: id.vodId });
  if (data.list.length !== 1 || String(data.list[0]?.vod_id) !== id.vodId) {
    throw new Error('ប្រភព CMS បញ្ជូនទិន្នន័យរឿងមិនត្រូវគ្នា');
  }
  const item = data.list[0];
  if (!normalizeItem(item, source)) throw new Error('ទិន្នន័យរឿងមិនត្រឹមត្រូវ');
  return { id, source, item };
}

async function fetchEpisodeList(seriesId) {
  const { id, source, item } = await fetchDetail(seriesId);
  const lines = extractMediaLines(item).sort((a, b) => b.episodes.length - a.episodes.length);
  if (!lines.length) throw new Error('រឿងនេះមិនមាន Link MP4 ឬ M3U8 ដែលអាចទាញបានទេ');
  const norm = normalizeItem(item, source);
  const seen = new Set();
  const episodes = lines[0].episodes
    .filter((ep) => {
      if (seen.has(ep.key)) return false;
      seen.add(ep.key);
      return true;
    })
    .map((ep, idx) => ({
      vid: `${id.seriesId}:${ep.line}:${ep.episode}`,
      vid_index: idx + 1,
      title: ep.title,
      series_id: id.seriesId,
      series_title: norm.series_title,
      cover: norm.cover,
      locked: norm.locked,
      source: norm.source,
    }));
  return { ...norm, total: episodes.length, episodes };
}

async function fetchPlayUrlSingle(vid, sid) {
  try {
    const id = parseId(vid, true);
    if (sid && parseId(sid).seriesId !== id.seriesId) {
      throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
    }
    const { source, item } = await fetchDetail(id.seriesId);
    if (isLocked(item)) {
      return { url: null, locked: true, source: `custom:${id.id}`, error: 'រឿងនេះតម្រូវឱ្យបង់ប្រាក់ ឬដាក់លេខសម្ងាត់' };
    }
    const lines = extractMediaLines(item);
    const selected = lines.find((l) => l.line === id.line)?.episodes.find((ep) => ep.episode === id.episode);
    if (!selected) throw new Error('រកមិនឃើញ Link វីដេអូសម្រាប់ភាគនេះទេ');
    const referer = new URL(source.url).origin + '/';
    const variants = [selected, ...lines.flatMap((l) => l.episodes.filter((ep) => ep.key === selected.key))]
      .filter((ep, i, all) => all.findIndex((o) => o.url === ep.url) === i)
      .map((ep) => ({
        url: ep.url,
        format: ep.format,
        source: `custom:${id.id}`,
        spadeA: null,
        codec: '',
        vid: `${id.seriesId}:${ep.line}:${ep.episode}`,
        userAgent: USER_AGENT,
        referer,
      }));
    return { ...variants[0], variants };
  } catch (err) {
    return { url: null, source: 'custom', spadeA: null, codec: null, error: err.message };
  }
}

function findShortDramaGenre(genres = []) {
  if (!Array.isArray(genres) || !genres.length) return null;
  const exact = genres.find((g) => /^(?:微?短剧(?:大全)?|精品短剧|爽文短剧)$/i.test(String(g?.label || '').trim()));
  if (exact) return exact;
  return genres.find((g) => /短剧|微短剧|短片|short\s*drama|mini\s*drama/i.test(String(g?.label || ''))) || null;
}

async function testCustomSource(draft, options = {}) {
  try {
    const source = validateSource(draft);
    const data = await cmsRequest(source, { pg: 1 }, options);
    const parsed = formatPageResult(data, source, 1);
    const shortDramaGenre = findShortDramaGenre(parsed.genres);
    return {
      success: true,
      source,
      count: parsed.results.length,
      genres: parsed.genres,
      hasShortDrama: Boolean(shortDramaGenre),
      shortDramaGenre,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function tryParseJsonRelaxed(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    try {
      const stripped = clean.replace(/^\s*\/\/.*$/gm, '');
      return JSON.parse(stripped);
    } catch (__) {
      return null;
    }
  }
}

function extractEntriesFromContainer(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj.sites)) return obj.sites;
  if (obj.sites && Array.isArray(obj.sites.data)) return obj.sites.data;
  if (Array.isArray(obj.tbl_site)) return obj.tbl_site;
  if (Array.isArray(obj.CUSTOM_SOURCES)) return obj.CUSTOM_SOURCES;
  if (Array.isArray(obj.sources)) return obj.sources;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.list)) return obj.list;
  return [];
}

function parseBatchEntries(rawInput) {
  const rawItems = [];
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) throw new Error('សូមបញ្ចូល JSON ឬ Link ប្រភព');
    const parsed = tryParseJsonRelaxed(trimmed);
    if (parsed !== null) {
      rawItems.push(...extractEntriesFromContainer(parsed));
    } else {
      for (const line of trimmed.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || s.startsWith('//')) continue;
        const pipeIdx = s.indexOf('|');
        const commaIdx = s.indexOf(',');
        const splitIdx = pipeIdx > 0 ? pipeIdx : (commaIdx > 0 && !s.startsWith('http') ? commaIdx : -1);
        if (splitIdx > 0) {
          rawItems.push({ name: s.slice(0, splitIdx).trim(), url: s.slice(splitIdx + 1).trim() });
        } else {
          rawItems.push({ url: s });
        }
      }
    }
  } else if (rawInput && typeof rawInput === 'object') {
    rawItems.push(...extractEntriesFromContainer(rawInput));
  }

  const candidates = [];
  const seen = new Set();
  let skippedCount = 0;

  for (const entry of rawItems) {
    if (!entry) continue;
    const isStr = typeof entry === 'string';
    const rawUrl = plainText(isStr ? entry : (entry.api || entry.url || entry.apiUrl || entry.endpoint || ''));
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      skippedCount += 1;
      continue;
    }
    const typeNum = !isStr && entry.type !== undefined && entry.type !== '' ? Number(entry.type) : null;
    const looksLikeMacCms = /\/api\.php\/provide\/vod\b/i.test(rawUrl);
    if (!isStr && typeNum !== null && ![0, 1].includes(typeNum) && !looksLikeMacCms) {
      skippedCount += 1;
      continue;
    }
    if (!isStr && typeof entry.api === 'string' && !looksLikeMacCms && /csp_|drpy|\.js$/i.test(rawUrl)) {
      skippedCount += 1;
      continue;
    }
    let fallbackName = '';
    try { fallbackName = new URL(rawUrl).hostname; } catch (_) {}
    const rawName = plainText(isStr ? '' : (entry.name || entry.title || entry.key || '')) || fallbackName || 'Custom CMS';
    const name = rawName.slice(0, 80);
    try {
      const normalized = validateSource({ name, url: rawUrl, enabled: isStr ? true : entry.isActive !== false && entry.enabled !== false });
      const key = endpointKey(normalized.url);
      if (seen.has(key)) {
        skippedCount += 1;
        continue;
      }
      seen.add(key);
      candidates.push(normalized);
    } catch (_) {
      skippedCount += 1;
    }
  }

  const truncatedCount = Math.max(0, candidates.length - MAX_BATCH_CANDIDATES);
  return {
    candidates: candidates.slice(0, MAX_BATCH_CANDIDATES),
    skippedCount,
    truncatedCount,
  };
}

async function fetchRemoteBatchPayload(urlStr) {
  if (!isPublicMediaUrl(urlStr)) throw new Error('Subscription URL ត្រូវតែជា Public HTTP/HTTPS URL');
  const guard = webMediaRequestOptions(urlStr);
  const res = await axios.get(urlStr, {
    ...guard,
    adapter: 'http',
    timeout: 10000,
    maxContentLength: 4 * 1024 * 1024,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { Accept: 'application/json,text/plain,*/*', 'User-Agent': USER_AGENT },
  });
  const parsed = tryParseJsonRelaxed(res.data);
  if (!parsed) throw new Error('Link JSON មិនបានត្រឡប់ទិន្នន័យ JSON ត្រឹមត្រូវទេ');
  return parsed;
}

async function batchTestSources({ input, timeoutMs = 7000, concurrency = 5, existingSources = [] } = {}) {
  let effectiveInput = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const isSingleLine = trimmed && !/[\r\n]/.test(trimmed);
    if (isSingleLine && /^https?:\/\/\S+$/i.test(trimmed) && !/\/api\.php\/provide\/vod\b/i.test(trimmed)) {
      const fetched = await fetchRemoteBatchPayload(trimmed);
      if (fetched && Number(fetched.code) === 1 && Array.isArray(fetched.list)) {
        effectiveInput = trimmed;
      } else {
        effectiveInput = fetched;
      }
    }
  }

  const { candidates, skippedCount, truncatedCount } = parseBatchEntries(effectiveInput);
  if (!candidates.length) {
    throw new Error('រកមិនឃើញ MacCMS HTTP/HTTPS API ត្រឹមត្រូវក្នុងទិន្នន័យនេះទេ');
  }

  const existingKeys = new Set((Array.isArray(existingSources) ? existingSources : []).map((s) => endpointKey(s.url)));
  const results = new Array(candidates.length);
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 5), candidates.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < candidates.length) {
      const idx = cursor;
      cursor += 1;
      const cand = candidates[idx];
      const alreadyAdded = existingKeys.has(endpointKey(cand.url));
      const t0 = Date.now();
      const res = await testCustomSource(cand, { timeoutMs });
      const latencyMs = Date.now() - t0;
      results[idx] = {
        name: cand.name,
        url: cand.url,
        ok: Boolean(res.success),
        count: res.success ? (res.count || 0) : 0,
        genreCount: res.success && Array.isArray(res.genres) ? res.genres.length : 0,
        hasShortDrama: Boolean(res.hasShortDrama),
        shortDramaGenre: res.shortDramaGenre || null,
        latencyMs,
        alreadyAdded,
        error: res.success ? '' : (res.error || 'បរាជ័យ'),
      };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    success: true,
    totalParsed: candidates.length,
    skippedCount,
    truncatedCount,
    results,
    summary: {
      total: results.length,
      working: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      shortDramaCount: results.filter((r) => r.ok && r.hasShortDrama).length,
      alreadyAddedCount: results.filter((r) => r.alreadyAdded).length,
    },
  };
}

module.exports = {
  validateSource,
  endpointKey,
  setCustomSources,
  getCustomSources,
  testCustomSource,
  parseBatchEntries,
  batchTestSources,
  resolveSeriesId,
  browseList,
  search,
  fetchEpisodeList,
  fetchPlayUrlSingle,
};
