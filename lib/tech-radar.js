const {
  defaultGithubRequest,
  sendTelegramAlert,
  loadTelegramConfigFromEnvFile,
} = require('./upstream-watcher');

const CORE_OPEN_SOURCE_TOOLS = [
  'yt-dlp/yt-dlp',
  'nilaoda/N_m3u8DL-RE',
  'BtbN/FFmpeg-Builds',
  'aria2/aria2',
  'electron/electron',
];

const UNSAFE_TECH_PATTERN = /\b(?:crack(?:ed|ing)?|keygen|patch(?:er|ed)?|warez|nulled|hack(?:ed|ing|er)?|bypass(?:er|ing)?|exploit(?:s|ing)?|stealer|rat|trojan|malware|ddos|phish(?:ing)?|pirat(?:e|ed|cy)|free[-\s]?vip[-\s]?crack|mod[-\s]?apk)\b/i;

function isSafeOpenSourceItem(item = {}) {
  const haystack = [
    item.title,
    item.name,
    item.fullName,
    item.description,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ]
    .filter(Boolean)
    .join(' ');
  return !UNSAFE_TECH_PATTERN.test(haystack);
}

function escapeHtml(text = '') {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildGithubHeaders(token = '') {
  const auth = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return {
    'User-Agent': 'EZA-PRO-Tech-Radar/1.0',
    Accept: 'application/vnd.github+json',
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
  };
}

/**
 * Fetch latest releases for core open-source media & desktop engines used by EZA PRO.
 */
async function fetchCoreToolReleases({ token = '', requestFn = defaultGithubRequest, recentHours = 48 } = {}) {
  const headers = buildGithubHeaders(token);
  const cutoffMs = Date.now() - recentHours * 3600 * 1000;
  const rows = await Promise.all(
    CORE_OPEN_SOURCE_TOOLS.map(async (repo) => {
      try {
        const res = await requestFn(`https://api.github.com/repos/${repo}/releases/latest`, { headers, timeoutMs: 9000 });
        if (res.status !== 200 || !res.json || !res.json.tag_name) return null;
        const publishedAt = res.json.published_at || res.json.created_at || '';
        const ts = Date.parse(publishedAt) || 0;
        return {
          repo,
          tag: String(res.json.tag_name).trim(),
          name: String(res.json.name || res.json.tag_name).trim(),
          url: String(res.json.html_url || `https://github.com/${repo}/releases`),
          publishedAt,
          isRecent: ts >= cutoffMs,
          key: `rel:${repo}@${String(res.json.tag_name).trim()}`,
        };
      } catch (_) {
        return null;
      }
    })
  );
  return rows.filter(Boolean);
}

async function searchGithubRepos(query, { sort = 'stars', perPage = 6, token = '', requestFn = defaultGithubRequest } = {}) {
  const headers = buildGithubHeaders(token);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}&order=desc&per_page=${perPage}`;
  try {
    const res = await requestFn(url, { headers, timeoutMs: 9000 });
    if (res.status !== 200 || !Array.isArray(res.json?.items)) return [];
    return res.json.items
      .map((r) => ({
        fullName: String(r.full_name || ''),
        url: String(r.html_url || ''),
        stars: Number(r.stargazers_count) || 0,
        language: String(r.language || ''),
        description: String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        updatedAt: String(r.pushed_at || r.updated_at || ''),
        tags: Array.isArray(r.topics) ? r.topics : [],
        key: `repo:${r.full_name}`,
      }))
      .filter((r) => r.fullName && r.url && isSafeOpenSourceItem(r));
  } catch (_) {
    return [];
  }
}

/**
 * Fetch trending & newest open-source engineering articles from Viblo Asia (Vietnam dev community).
 */
async function fetchVibloVietnamPosts({ requestFn = defaultGithubRequest, limit = 10 } = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 EZA-PRO-Tech-Radar/1.0',
    Accept: 'application/json',
  };
  const out = [];
  const seen = new Set();

  for (const feed of ['trending', 'newest']) {
    try {
      const res = await requestFn(`https://viblo.asia/api/posts?feed=${feed}&limit=${limit}`, { headers, timeoutMs: 9000 });
      if (res.status !== 200 || !Array.isArray(res.json?.data)) continue;
      for (const p of res.json.data) {
        const title = String(p?.title || '').trim();
        const postUrl = String(p?.url || (p?.slug ? `https://viblo.asia/p/${p.slug}` : '')).trim();
        if (!title || !postUrl || seen.has(postUrl)) continue;
        const tags = Array.isArray(p?.tags?.data) ? p.tags.data.map((t) => t?.name).filter(Boolean) : [];
        const item = {
          title: title.slice(0, 110),
          url: postUrl,
          author: String(p?.user?.data?.username || p?.user?.username || ''),
          tags: tags.slice(0, 4),
          views: Number(p?.views_count) || 0,
          points: Number(p?.points) || 0,
          key: `viblo:${p.slug || postUrl}`,
        };
        if (!isSafeOpenSourceItem(item)) continue;
        seen.add(postUrl);
        out.push(item);
      }
    } catch (_) {}
  }

  return out;
}

/**
 * Collect a legitimate daily open-source tech & media dev digest across GitHub & Viblo Vietnam.
 */
async function buildDailyTechDigest({
  token = '',
  requestFn = defaultGithubRequest,
  seenKeys = new Set(),
  nowDate = new Date(),
} = {}) {
  const isoDay = (daysAgo) => new Date(nowDate.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);
  const since30 = isoDay(30);
  const since7 = isoDay(7);

  const [releases, mediaRepos, dramaOssRepos, vietnamRepos, vibloPosts] = await Promise.all([
    fetchCoreToolReleases({ token, requestFn, recentHours: 48 }),
    searchGithubRepos(`(ffmpeg OR yt-dlp OR m3u8 OR downloader OR "video player") created:>=${since30} stars:>=15`, { sort: 'stars', perPage: 6, token, requestFn }),
    searchGithubRepos(`(dramabox OR reelshort OR hongguo OR "short drama") pushed:>=${since30} stars:>=5`, { sort: 'updated', perPage: 6, token, requestFn }),
    searchGithubRepos(`topic:vietnam pushed:>=${since7} stars:>=10`, { sort: 'stars', perPage: 6, token, requestFn }),
    fetchVibloVietnamPosts({ requestFn, limit: 8 }),
  ]);

  const notSeen = (arr) => arr.filter((x) => x && !seenKeys.has(x.key));

  const newReleases = notSeen(releases.filter((r) => r.isRecent));
  const fallbackReleases = releases.slice(0, 3);
  const topMediaRepos = notSeen(mediaRepos).slice(0, 4);
  const topDramaRepos = notSeen(dramaOssRepos).slice(0, 4);
  const topVietnamRepos = notSeen(vietnamRepos).slice(0, 4);
  const topVibloPosts = notSeen(vibloPosts).slice(0, 5);

  const collectedKeys = [
    ...newReleases.map((r) => r.key),
    ...topMediaRepos.map((r) => r.key),
    ...topDramaRepos.map((r) => r.key),
    ...topVietnamRepos.map((r) => r.key),
    ...topVibloPosts.slice(0, 3).map((p) => p.key),
  ];

  return {
    generatedAt: nowDate.toISOString(),
    dateLabel: nowDate.toISOString().slice(0, 10),
    newReleases,
    coreReleasesSnapshot: fallbackReleases,
    mediaRepos: topMediaRepos,
    dramaRepos: topDramaRepos,
    vietnamRepos: topVietnamRepos,
    vibloPosts: topVibloPosts,
    collectedKeys,
    hasAnyItems: Boolean(
      newReleases.length || topMediaRepos.length || topDramaRepos.length || topVietnamRepos.length || topVibloPosts.length
    ),
  };
}

/**
 * Format digest into Telegram HTML message(s) strictly bounded cleanly under Telegram 4096-char limit.
 */
function formatTelegramDigestMessages(digest, { maxLen = 3800 } = {}) {
  const sections = [];

  if (digest.newReleases?.length) {
    sections.push([
      `🚀 <b>Open-Source Engine Releases ថ្មីៗ (48h)</b>`,
      ...digest.newReleases.map((r) => `• <a href="${escapeHtml(r.url)}">${escapeHtml(r.repo)}</a> — <code>${escapeHtml(r.tag)}</code>`),
    ].join('\n'));
  } else if (digest.coreReleasesSnapshot?.length) {
    sections.push([
      `⚙️ <b>Core Open-Source Versions បច្ចុប្បន្ន</b>`,
      ...digest.coreReleasesSnapshot.map((r) => `• <a href="${escapeHtml(r.url)}">${escapeHtml(r.repo)}</a> — <code>${escapeHtml(r.tag)}</code>`),
    ].join('\n'));
  }

  if (digest.mediaRepos?.length) {
    sections.push([
      `🎬 <b>GitHub Media / Video / FFmpeg Tools ថ្មីៗ</b>`,
      ...digest.mediaRepos.map((r) => `• <a href="${escapeHtml(r.url)}">${escapeHtml(r.fullName)}</a> (⭐${r.stars})${r.description ? `\n  <i>${escapeHtml(r.description)}</i>` : ''}`),
    ].join('\n'));
  }

  if (digest.dramaRepos?.length) {
    sections.push([
      `📺 <b>Open-Source Drama / Catalog Ecosystem</b>`,
      ...digest.dramaRepos.map((r) => `• <a href="${escapeHtml(r.url)}">${escapeHtml(r.fullName)}</a> (⭐${r.stars})${r.description ? `\n  <i>${escapeHtml(r.description)}</i>` : ''}`),
    ].join('\n'));
  }

  if (digest.vietnamRepos?.length) {
    sections.push([
      `🇻🇳 <b>GitHub Vietnam Open-Source លេចធ្លោ</b>`,
      ...digest.vietnamRepos.map((r) => `• <a href="${escapeHtml(r.url)}">${escapeHtml(r.fullName)}</a> (⭐${r.stars})${r.description ? `\n  <i>${escapeHtml(r.description)}</i>` : ''}`),
    ].join('\n'));
  }

  if (digest.vibloPosts?.length) {
    sections.push([
      `📰 <b>Viblo Vietnam Dev — បច្ចេកទេស &amp; Coding ថ្មីៗ</b>`,
      ...digest.vibloPosts.map((p) => {
        const tagTxt = p.tags?.length ? ` [${escapeHtml(p.tags.slice(0, 3).join(', '))}]` : '';
        return `• <a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>${tagTxt}`;
      }),
    ].join('\n'));
  }

  const header = `☀️ <b>EZA PRO Daily Open-Source Tech Radar (${escapeHtml(digest.dateLabel)})</b>\n`;
  if (!sections.length) {
    return [`${header}\n✅ ថ្ងៃនេះមិនទាន់មាន Tool ឬអត្ថបទ Open-Source ថ្មីប្លែកទេ។`];
  }

  const messages = [];
  let current = header;
  for (const sec of sections) {
    const candidate = current ? `${current}\n${sec}\n` : `${sec}\n`;
    if (candidate.length > maxLen && current.trim()) {
      messages.push(current.trim());
      current = `${sec}\n`;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

module.exports = {
  CORE_OPEN_SOURCE_TOOLS,
  isSafeOpenSourceItem,
  fetchCoreToolReleases,
  searchGithubRepos,
  fetchVibloVietnamPosts,
  buildDailyTechDigest,
  formatTelegramDigestMessages,
  sendTelegramAlert,
  loadTelegramConfigFromEnvFile,
};
