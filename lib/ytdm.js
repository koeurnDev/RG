const axios = require('axios');
const { isPublicMediaUrl } = require('../hongguo-drama/src/native/web-media-guard');
const ytdlp = require('./ytdlp');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YT_VIDEO_RE = /^[A-Za-z0-9_-]{8,20}$/;
const YT_PLAYLIST_RE = /^[A-Za-z0-9_-]{10,64}$/;
const DM_ID_RE = /^[A-Za-z0-9]{5,20}$/;

const GENRES = [
  {
    slug: 'khmer',
    label: '🇰🇭 រឿងភាគខ្មែរ / និយាយខ្មែរ',
    ytQueries: ['រឿងភាគខ្មែរ full', 'រឿងនិយាយខ្មែរ ពេញ', 'khmer drama full episode', 'រឿងខ្មែរថ្មី full'],
    dmQueries: ['khmer drama', 'រឿងភាគខ្មែរ'],
    playlistMode: 'mix',
  },
  {
    slug: 'playlists',
    label: '📚 រឿងភាគជាឈុត (Playlist)',
    ytQueries: ['រឿងភាគនិយាយខ្មែរ', 'thai drama khmer dubbed', 'chinese drama khmer dubbed', 'khmer drama full'],
    dmQueries: [],
    playlistMode: 'only',
  },
  {
    slug: 'thai',
    label: '🇹🇭 រឿងថៃនិយាយខ្មែរ',
    ytQueries: ['រឿងថៃនិយាយខ្មែរ full', 'thai drama khmer dubbed full', 'រឿងភាគថៃនិយាយខ្មែរ'],
    dmQueries: ['thai drama khmer dubbed', 'thai lakorn full'],
    playlistMode: 'mix',
  },
  {
    slug: 'cdrama',
    label: '🇨🇳 រឿងចិននិយាយខ្មែរ',
    ytQueries: ['រឿងចិននិយាយខ្មែរ full', 'រឿងចិនបុរាណនិយាយខ្មែរ', 'chinese drama khmer dubbed full'],
    dmQueries: ['chinese drama khmer', 'cdrama full'],
    playlistMode: 'mix',
  },
  {
    slug: 'kdrama',
    label: '🇰🇷 រឿងកូរ៉េពេញ / សម្រាយ',
    ytQueries: ['រឿងកូរ៉េនិយាយខ្មែរ full', 'korean drama khmer dubbed', 'korean drama full movie'],
    dmQueries: ['korean drama khmer', 'kdrama full'],
    playlistMode: 'mix',
  },
  {
    slug: 'short_full',
    label: '⚡ រឿងខ្លីចិន Full (ឥត VIP)',
    ytQueries: ['短剧 全集', 'short drama full movie eng sub', 'រឿងសម្រាយចិន full'],
    dmQueries: ['short drama full movie', '短剧 全集'],
    playlistMode: 'video',
  },
  {
    slug: 'anime',
    label: '🎨 Anime / តុក្កតា',
    ytQueries: ['រឿងនិទានខ្មែរ full', 'anime khmer sub full episode', 'donghua full episode'],
    dmQueries: ['donghua full episode', 'anime full episode'],
    playlistMode: 'mix',
  },
];

const detailCache = new Map();

function plainText(v) {
  return String(v || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function safeHttpsUrl(v) {
  try {
    const raw = String(v || '').trim().replace(/^\/\//, 'https://');
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && isPublicMediaUrl(u.href) ? u.href : '';
  } catch (_) {
    return '';
  }
}

function parseClockSec(text = '') {
  const parts = String(text || '').trim().split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function parseId(value) {
  const s = String(value || '').trim();
  const parts = s.split(':');
  if (parts[0] !== 'ytdm' || parts.length !== 3) {
    throw new Error('YouTube / Dailymotion ID មិនត្រឹមត្រូវ');
  }
  const kind = parts[1];
  const rawId = parts[2];
  if (kind === 'pl' && YT_PLAYLIST_RE.test(rawId)) return { kind: 'pl', id: rawId, seriesId: `ytdm:pl:${rawId}` };
  if (kind === 'v' && YT_VIDEO_RE.test(rawId)) return { kind: 'v', id: rawId, seriesId: `ytdm:v:${rawId}` };
  if (kind === 'dm' && DM_ID_RE.test(rawId)) return { kind: 'dm', id: rawId, seriesId: `ytdm:dm:${rawId}` };
  throw new Error('YouTube / Dailymotion ID មិនត្រឹមត្រូវ');
}

function resolveSeriesId(input) {
  const s = String(input || '').trim();
  if (s.startsWith('ytdm:')) return parseId(s).seriesId;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new Error('Link YouTube / Dailymotion មិនត្រឹមត្រូវ');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const vid = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (YT_VIDEO_RE.test(vid)) return `ytdm:v:${vid}`;
  }
  if (/(?:^|\.)youtube\.com$/.test(host)) {
    const listId = u.searchParams.get('list') || '';
    const vId = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{8,20})/)?.[1] || '';
    if ((u.pathname.startsWith('/playlist') || (!vId && listId)) && YT_PLAYLIST_RE.test(listId)) {
      return `ytdm:pl:${listId}`;
    }
    if (YT_VIDEO_RE.test(vId)) return `ytdm:v:${vId}`;
  }
  if (/(?:^|\.)dailymotion\.com$/.test(host)) {
    const dmId = u.pathname.match(/\/video\/([A-Za-z0-9]{5,20})/)?.[1] || '';
    if (DM_ID_RE.test(dmId)) return `ytdm:dm:${dmId}`;
  }
  if (host === 'dai.ly') {
    const dmId = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (DM_ID_RE.test(dmId)) return `ytdm:dm:${dmId}`;
  }
  throw new Error('Link មិនមែនជា YouTube ឬ Dailymotion ទេ');
}

function parseYoutubePlaylistCount(badges = []) {
  for (const b of badges) {
    const txt = String(b?.thumbnailBadgeViewModel?.text || '');
    const m = txt.match(/(\d+)/);
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}

function extractYoutubeItems(html, { playlistOnly = false, minDurationSec = 240 } = {}) {
  const match = String(html || '').match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (_) {
    return [];
  }
  const secs = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const rawItems = secs.flatMap((s) => s?.itemSectionRenderer?.contents || []);
  const cards = [];

  for (const entry of rawItems) {
    const lk = entry?.lockupViewModel;
    if (lk && lk.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' && YT_PLAYLIST_RE.test(String(lk.contentId || ''))) {
      const plId = String(lk.contentId);
      const thumbSources = lk.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources || [];
      const overlays = lk.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays || [];
      const badges = overlays.flatMap((o) => o?.thumbnailOverlayBadgeViewModel?.thumbnailBadges || []);
      const count = parseYoutubePlaylistCount(badges);
      const title = plainText(lk.metadata?.lockupMetadataViewModel?.title?.content);
      if (!title) continue;
      cards.push({
        series_id: `ytdm:pl:${plId}`,
        series_title: title.slice(0, 120),
        cover: safeHttpsUrl(thumbSources.slice(-1)[0]?.url),
        episode_count: count || 10,
        tags: ['YouTube', 'Playlist', ...(count ? [`${count} ភាគ`] : [])],
        source: 'ytdm',
        url: `https://www.youtube.com/playlist?list=${plId}`,
      });
      continue;
    }

    if (playlistOnly) continue;
    const v = entry?.videoRenderer;
    if (!v || !YT_VIDEO_RE.test(String(v.videoId || ''))) continue;
    const durText = v.lengthText?.simpleText || '';
    const durSec = parseClockSec(durText);
    if (durSec > 0 && durSec < minDurationSec) continue;
    const title = plainText((v.title?.runs || []).map((r) => r.text).join('') || v.title?.simpleText || '');
    if (!title) continue;
    cards.push({
      series_id: `ytdm:v:${v.videoId}`,
      series_title: title.slice(0, 120),
      cover: safeHttpsUrl(v.thumbnail?.thumbnails?.slice(-1)[0]?.url),
      episode_count: 1,
      tags: ['YouTube', durText || 'Full'].filter(Boolean),
      source: 'ytdm',
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    });
  }
  return cards;
}

async function searchYoutube(query, { playlistOnly = false, minDurationSec = 240 } = {}) {
  try {
    const params = { search_query: query };
    if (playlistOnly) params.sp = 'EgIQAw%3D%3D';
    const res = await axios.get('https://www.youtube.com/results', {
      params,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 8000,
      responseType: 'text',
    });
    return extractYoutubeItems(res.data, { playlistOnly, minDurationSec });
  } catch (_) {
    return [];
  }
}

async function searchDailymotion(query, page = 1, { limit = 15, minDurationSec = 180 } = {}) {
  try {
    const res = await axios.get('https://api.dailymotion.com/videos', {
      params: {
        search: query,
        fields: 'id,title,duration,thumbnail_480_url,url,owner.screenname',
        limit,
        page,
      },
      timeout: 7000,
    });
    const list = Array.isArray(res.data?.list) ? res.data.list : [];
    return list
      .filter((v) => v && DM_ID_RE.test(String(v.id || '')) && (Number(v.duration) || 0) >= minDurationSec)
      .map((v) => ({
        series_id: `ytdm:dm:${v.id}`,
        series_title: plainText(v.title).slice(0, 120) || `Dailymotion_${v.id}`,
        cover: safeHttpsUrl(v.thumbnail_480_url),
        episode_count: 1,
        tags: ['Dailymotion', plainText(v['owner.screenname']) || 'Full'].filter(Boolean).slice(0, 3),
        source: 'ytdm',
        url: safeHttpsUrl(v.url) || `https://www.dailymotion.com/video/${v.id}`,
      }));
  } catch (_) {
    return [];
  }
}

function dedupeCards(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || !row.series_id || seen.has(row.series_id)) continue;
    seen.add(row.series_id);
    out.push(row);
  }
  return out;
}

async function browseList({ genre = '', page = 1 } = {}) {
  try {
    const pg = Math.max(1, Number(page) || 1);
    const active = GENRES.find((g) => g.slug === genre) || GENRES[0];
    const genres = GENRES.map((g) => ({ slug: g.slug, label: g.label }));

    const ytQuery = active.ytQueries[(pg - 1) % active.ytQueries.length];
    const dmQuery = active.dmQueries.length ? active.dmQueries[(pg - 1) % active.dmQueries.length] : '';
    const dmPage = Math.floor((pg - 1) / Math.max(1, active.dmQueries.length)) + 1;

    const tasks = [
      searchYoutube(ytQuery, {
        playlistOnly: active.playlistMode === 'only',
        minDurationSec: active.playlistMode === 'video' ? 180 : 300,
      }),
    ];
    if (active.playlistMode === 'mix') {
      tasks.push(searchYoutube(ytQuery, { playlistOnly: true }));
    }
    if (dmQuery) {
      tasks.push(searchDailymotion(dmQuery, dmPage, { limit: 15, minDurationSec: 240 }));
    }

    const batches = await Promise.all(tasks);
    const interleaved = [];
    const maxLen = Math.max(0, ...batches.map((b) => b.length));
    for (let i = 0; i < maxLen; i += 1) {
      for (const batch of batches) {
        if (batch[i]) interleaved.push(batch[i]);
      }
    }
    const results = dedupeCards(interleaved);

    return {
      success: true,
      results,
      page: pg,
      hasMore: results.length > 0 && pg < 8,
      genres,
      pageTitle: 'YouTube / Dailymotion',
      sourceUrl: 'https://www.youtube.com',
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

    const [ytVideos, ytPlaylists, dmList] = await Promise.all([
      pg === 1 ? searchYoutube(kw, { playlistOnly: false, minDurationSec: 120 }) : Promise.resolve([]),
      pg === 1 ? searchYoutube(kw, { playlistOnly: true }) : Promise.resolve([]),
      searchDailymotion(kw, pg, { limit: 18, minDurationSec: 120 }),
    ]);

    const combined = pg === 1 ? [...ytPlaylists, ...dmList, ...ytVideos] : dmList;
    const results = dedupeCards(combined);
    return {
      success: true,
      results,
      page: pg,
      hasMore: dmList.length >= 15,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchEpisodeList(seriesId, options = {}) {
  const parsed = parseId(seriesId);
  const cached = detailCache.get(parsed.seriesId);
  if (options.force !== true && cached && Date.now() - cached.at < 60 * 1000) {
    return cached.data;
  }

  let out;
  if (parsed.kind === 'pl') {
    const plUrl = `https://www.youtube.com/playlist?list=${parsed.id}`;
    const info = await ytdlp.probeUrl(plUrl);
    const rawEntries = Array.isArray(info.entries) && info.entries.length > 0
      ? info.entries
      : [{ index: 1, id: info.id, title: info.title, thumbnail: info.thumbnail }];
    const seriesTitle = plainText(info.title) || `Playlist_${parsed.id}`;
    const firstId = rawEntries.find((e) => YT_VIDEO_RE.test(String(e?.id || '')))?.id || '';
    const cover = safeHttpsUrl(info.thumbnail) || (firstId ? `https://i.ytimg.com/vi/${firstId}/hqdefault.jpg` : '');
    const episodes = rawEntries
      .filter((e) => e && YT_VIDEO_RE.test(String(e.id || '')))
      .map((e, idx) => {
        const epNum = idx + 1;
        return {
          vid: `ytdm:v:${e.id}`,
          vid_index: epNum,
          title: plainText(e.title) || `EP ${epNum}`,
          series_id: parsed.seriesId,
          series_title: seriesTitle,
          cover: safeHttpsUrl(e.thumbnail) || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` || cover,
          locked: false,
          source: 'ytdm',
        };
      });
    if (!episodes.length) throw new Error('Playlist នេះមិនមានវីដេអូសាធារណៈទេ');
    out = {
      series_id: parsed.seriesId,
      series_title: seriesTitle,
      cover,
      intro: info.uploader ? `Channel: ${plainText(info.uploader)}` : '',
      total: episodes.length,
      episodes,
      source: 'ytdm',
    };
  } else if (parsed.kind === 'v') {
    const watchUrl = `https://www.youtube.com/watch?v=${parsed.id}`;
    let title = `YouTube_${parsed.id}`;
    let cover = `https://i.ytimg.com/vi/${parsed.id}/hqdefault.jpg`;
    let uploader = '';
    try {
      const oe = (await axios.get('https://www.youtube.com/oembed', {
        params: { url: watchUrl, format: 'json' },
        timeout: 5000,
      })).data;
      if (oe?.title) title = plainText(oe.title);
      if (oe?.thumbnail_url) cover = safeHttpsUrl(oe.thumbnail_url) || cover;
      if (oe?.author_name) uploader = plainText(oe.author_name);
    } catch (_) {}
    out = {
      series_id: parsed.seriesId,
      series_title: title,
      cover,
      intro: uploader ? `Channel: ${uploader}` : '',
      total: 1,
      episodes: [{
        vid: parsed.seriesId,
        vid_index: 1,
        title: 'EP 1 (Full Video)',
        series_id: parsed.seriesId,
        series_title: title,
        cover,
        locked: false,
        source: 'ytdm',
      }],
      source: 'ytdm',
    };
  } else {
    const res = await axios.get(`https://api.dailymotion.com/video/${parsed.id}`, {
      params: { fields: 'id,title,thumbnail_480_url,description' },
      timeout: 7000,
    });
    const d = res.data || {};
    const title = plainText(d.title) || `Dailymotion_${parsed.id}`;
    const cover = safeHttpsUrl(d.thumbnail_480_url);
    out = {
      series_id: parsed.seriesId,
      series_title: title,
      cover,
      intro: plainText(d.description).slice(0, 300),
      total: 1,
      episodes: [{
        vid: parsed.seriesId,
        vid_index: 1,
        title: 'EP 1 (Full Video)',
        series_id: parsed.seriesId,
        series_title: title,
        cover,
        locked: false,
        source: 'ytdm',
      }],
      source: 'ytdm',
    };
  }

  detailCache.set(parsed.seriesId, { at: Date.now(), data: out });
  if (detailCache.size > 64) detailCache.delete(detailCache.keys().next().value);
  return out;
}

async function fetchPlayUrlSingle(vid, seriesId) {
  try {
    const vParsed = parseId(vid);
    if (vParsed.kind === 'pl') throw new Error('សូមជ្រើសភាគវីដេអូជាក់លាក់');
    if (seriesId) {
      const sParsed = parseId(seriesId);
      if (sParsed.kind !== 'pl' && sParsed.seriesId !== vParsed.seriesId) {
        throw new Error('ភាគមិនត្រូវគ្នាជាមួយរឿង');
      }
    }
    const watchUrl = vParsed.kind === 'v'
      ? `https://www.youtube.com/watch?v=${vParsed.id}`
      : `https://www.dailymotion.com/video/${vParsed.id}`;
    return {
      url: watchUrl,
      ytdlpUrl: watchUrl,
      isYtdlp: true,
      format: 'ytdlp',
      source: 'ytdm',
      spadeA: null,
      codec: 'h264',
      vid: vParsed.seriesId,
      userAgent: USER_AGENT,
      referer: vParsed.kind === 'v' ? 'https://www.youtube.com/' : 'https://www.dailymotion.com/',
    };
  } catch (err) {
    return { url: null, source: 'ytdm', spadeA: null, codec: null, error: err.message };
  }
}

module.exports = {
  resolveSeriesId,
  browseList,
  search,
  fetchEpisodeList,
  fetchPlayUrlSingle,
  extractYoutubeItems,
};
