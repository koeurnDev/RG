const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync, exec } = require('child_process');
const { fetchPlayUrlSingle } = require('./hongguo-drama/src/native/hongguo');

// Non-blocking async curl helper for high-speed multi-threaded downloading
function runCurlAsync(args) {
  return new Promise((resolve) => {
    const child = spawn('curl.exe', args, { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
const { searchHongguo } = require('./hongguo-drama/src/native/hongguo-search');
const { readRouterData } = require('./hongguo-drama/src/native/catalog');

const PORT = 3000;
let progressClients = [];
let currentDownloadJob = null;
const dramaCache = new Map();

// Configuration & Gemini API Key Storage
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ENV_FILE = path.join(__dirname, 'hongguo-drama', 'scripts', '.env');

// Parse a .env file and return key-value object
function parseEnvFile(filePath) {
  const result = {};
  try {
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes (" or ')
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch (_) {}
  return result;
}

// Save/update a key in .env file
function saveEnvFile(filePath, updates) {
  try {
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }
    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const newLine = `${key}="${val}"`;
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = content.trim() ? content.trim() + '\n' + newLine + '\n' : newLine + '\n';
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error('[ENV] Cannot save .env:', err.message);
  }
}

function loadConfig() {
  // Priority: .env file → config.json → process.env
  const envData = parseEnvFile(ENV_FILE);
  let cfg = { GEMINI_API_KEY: envData.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '' };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // .env takes priority over config.json
      if (!cfg.GEMINI_API_KEY && parsed.GEMINI_API_KEY) cfg.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    }
  } catch (_) {}
  return cfg;
}

function saveConfig(cfg) {
  // Save to both .env AND config.json for compatibility
  if (cfg.GEMINI_API_KEY) {
    saveEnvFile(ENV_FILE, { GEMINI_API_KEY: cfg.GEMINI_API_KEY });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    const ezargDir = 'D:\\EZARG';
    if (fs.existsSync(ezargDir)) {
      fs.writeFileSync(path.join(ezargDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch (_) {}
}

// Multi-Category Drama Engine & 10-Minute Auto-Refresh
const CATEGORIES = [
  { id: 'trending', name: '🔥 កំពុងល្បី', badge: 'HOT 100', icon: '🔥' },
  { id: 'sad', name: '😭 កម្សត់ & ទុក្ខសោក', badge: 'MELODRAMA', icon: '😭' },
  { id: 'sweet', name: '💖 Sweet & ផ្អែម', badge: 'SWEET', icon: '💖' },
  { id: 'romance', name: '🌹 ស្នេហារ៉ូមែនទិក', badge: 'ROMANCE', icon: '🌹' },
  { id: 'ceo', name: '👑 CEO & អភិជន', badge: 'BILLIONAIRE', icon: '👑' },
  { id: 'comeback', name: '⚔️ សងសឹក & វាយបក', badge: 'REVENGE', icon: '⚔️' },
  { id: 'costume', name: '⏳ ឆ្លងភព & បុរាណ', badge: 'HISTORICAL', icon: '⏳' },
  { id: 'comedy', name: '🎭 កំប្លែង & សប្បាយ', badge: 'COMEDY', icon: '🎭' },
  { id: 'family', name: '👨‍👩‍👧 គ្រួសារ & ជីវិត', badge: 'FAMILY', icon: '👨‍👩‍👧' },
  { id: 'suspense', name: '🔍 អាថ៌កំបាំង', badge: 'MYSTERY', icon: '🔍' }
];

const KHMER_DICT = [
  ['装穷提亲', 'បន្លំធ្វើអ្នកក្រទៅស្តីដណ្តឹង'],
  ['娶到全家嫌弃的她', 'រៀបការជាមួយនារីដែលគ្រួសារមើលងាយ'],
  ['一念沉沦', 'មួយរំពេចធ្លាក់ក្នុងអន្លង់ស្នេហ៍'],
  ['霍总心动了', 'លោកប្រធានហ័រចាប់ផ្តើមលង់'],
  ['二婚嫁对人', 'រៀបការលើកទីពីរជួបមនុស្សត្រូវ'],
  ['前夫悔破防', 'អតីតស្វាមីស្តាយក្រោយស្រក់ទឹកភ្នែក'],
  ['老公破产', 'ស្វាមីក្ស័យធន'],
  ['花瓶夫人', 'ភរិយារូបស្អាត'],
  ['诱情染指', 'អន្ទាក់ស្នេហ៍ល្បិច'],
  ['黎野入怀', 'លង់ក្នុងទ្រូងស្នេហា'],
  ['蚀骨罪', 'ទោសកំហុសស្នេហាឈឺចាប់ដល់ឆ្អឹង'],
  ['虐骨焚心', 'ឈឺចាប់កម្សត់ឆេះរោលក្នុងបេះដូង'],
  ['龙主归来', 'ស្តេចនាគត្រឡប់មកវិញ'],
  ['龙王归来', 'ស្តេចនាគត្រឡប់មកវិញ'],
  ['战神归来', 'ស្តេចសឹកត្រឡប់មកវិញ'],
  ['总裁归来', 'លោកប្រធានវិលត្រឡប់'],
  ['初尝玫瑰', 'ភ្លក់ផ្កាកុលាបលើកដំបូង'],
  ['山野春潮', 'រលកស្នេហ៍កណ្ដាលព្រៃភ្នំ'],
  ['绝世神医', 'កំពូលគ្រូពេទ្យទេព'],
  ['神医下山', 'ពេទ្យទេពចុះពីលើភ្នំ'],
  ['重生之', 'ចាប់កំណើតសារជាថ្មី '],
  ['重生', 'ចាប់កំណើតថ្មី'],
  ['穿越到', 'ឆ្លងភពទៅកាន់ '],
  ['穿越', 'ឆ្លងភព'],
  ['战神', 'ស្តេចសឹក'],
  ['逆袭', 'វាយបកយកឈ្នះ'],
  ['神医', 'ពេទ្យទេព'],
  ['甜宠', 'ស្នេហាផ្អែមល្ហែម'],
  ['虐恋', 'ស្នេហាឈឺចាប់កម្សត់'],
  ['先婚后爱', 'ការមុនស្រឡាញ់ក្រោយ'],
  ['暗恋成真', 'លួចស្រឡាញ់ក្លាយជាពិត'],
  ['一见钟情', 'ស្រឡាញ់តាំងពីជួបដំបូង'],
  ['闪婚', 'រៀបការបន្ទាន់'],
  ['豪门千金', 'អ្នកនាងម្ចាស់ត្រកូលអភិជន'],
  ['豪门', 'ត្រកូលអភិជន'],
  ['霸道总裁', 'លោកប្រធានផ្ដាច់ការ'],
  ['总裁', 'លោកប្រធាន'],
  ['前夫', 'អតីតស្វាមី'],
  ['前妻', 'អតីតភរិយា'],
  ['千金归来', 'អ្នកនាងម្ចាស់វិលត្រឡប់'],
  ['千金', 'អ្នកនាងម្ចាស់'],
  ['少爷', 'អ្នកប្រុស'],
  ['夫人', 'លោកស្រីភរិយា'],
  ['真假千金', 'អ្នកនាងពិតនិងក្លែងក្លាយ'],
  ['替嫁', 'រៀបការជំនួស'],
  ['带娃', 'នាំកូន'],
  ['萌宝', 'កូនឆ្លាតគួរឱ្យស្រឡាញ់'],
  ['首富', 'មហាសេដ្ឋីលេខ១'],
  ['无敌', 'ឥតផ្ទឹម'],
  ['开局', 'ចាប់ផ្ដើមរឿង']
];

function getKhmerTitle(title) {
  if (!title) return '';
  let kh = title;
  for (const [cn, km] of KHMER_DICT) {
    if (kh.includes(cn)) {
      kh = kh.split(cn).join(km + ' ');
    }
  }
  return kh === title ? '' : kh.trim();
}

let cachedTrendingDramas = [];
let nextRefreshTimestamp = Date.now() + 10 * 60 * 1000;
const categoryCache = new Map();

async function refreshTrendingDramas() {
  const axios = require('./hongguo-drama/node_modules/axios');
  const catalog = require('./hongguo-drama/src/native/catalog');
  const categories = ['hot-drama', 'hot-real-drama', 'hot-comic-drama'];
  const allDramas = [];
  const seen = new Set();

  for (const cat of categories) {
    for (let page = 1; page <= 4; page++) {
      if (allDramas.length >= 100) break;
      const url = `https://hongguoduanju.com/rank/${cat}${page > 1 ? '?page=' + page : ''}`;
      try {
        const res = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0' },
          timeout: 6000
        });
        const router = catalog.readRouterData(res.data);
        const content = router.loaderData?.['rank_' + cat + '/page']?.content;
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        if (parsed?.rankList) {
          for (const item of parsed.rankList) {
            if (item.seriesId && !seen.has(item.seriesId)) {
              seen.add(item.seriesId);
              const totalEps = Number(item.episodeCount || item.episode_count) || 80;
              allDramas.push({
                id: String(item.seriesId),
                title: String(item.title || 'Drama'),
                titleKhmer: getKhmerTitle(item.title),
                cover: item.cover || '',
                heat: item.heatText || '',
                total: totalEps,
                rank: allDramas.length + 1,
                tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : ['热门', '短剧']
              });
              if (allDramas.length >= 100) break;
            }
          }
        }
      } catch (_) {}
    }
  }

  if (allDramas.length > 0) {
    cachedTrendingDramas = allDramas;
    nextRefreshTimestamp = Date.now() + 10 * 60 * 1000;
    console.log(`[Trending] ទទួលបានរឿងភាគល្បីៗចំនួន ${cachedTrendingDramas.length} រឿងស្រស់ៗ!`);
  }
}

async function fetchCategoryDramas(category, page = 1, force = false) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const cacheKey = `${category}_p${pg}`;

  if (category === 'trending') {
    if (pg === 1) {
      if (force || cachedTrendingDramas.length === 0) await refreshTrendingDramas();
      return cachedTrendingDramas;
    }
    if (!force && categoryCache.has(cacheKey)) {
      return categoryCache.get(cacheKey).dramas;
    }
    const { browseList } = require('./hongguo-drama/src/native/catalog');
    const extraList = [];
    const seen = new Set();
    const genres = ['urban', 'romance', 'comeback', 'costume'];
    const targetGenre = genres[(pg - 2) % genres.length];
    const targetPage = Math.floor((pg - 2) / genres.length) + 1;
    try {
      const b = await browseList({ category: 'real-drama', genre: targetGenre, page: targetPage });
      (b.results || []).forEach(item => {
        if (item && item.series_id && !seen.has(item.series_id)) {
          seen.add(item.series_id);
          extraList.push({
            id: String(item.series_id),
            title: item.series_title,
            titleKhmer: getKhmerTitle(item.series_title),
            cover: item.cover || '',
            heat: '🔥 កំពុងល្បី',
            total: Number(item.episode_count) || 80,
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : ['កំពុងល្បី', 'ពេញនិយម'],
            category: 'trending',
            rank: 100 + (pg - 2) * 24 + extraList.length
          });
        }
      });
    } catch (_) {}
    categoryCache.set(cacheKey, { timestamp: Date.now(), dramas: extraList });
    return extraList;
  }

  if (!force && categoryCache.has(cacheKey)) {
    const cached = categoryCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 10 * 60 * 1000 && cached.dramas.length > 0) {
      return cached.dramas;
    }
  }

  const { searchHongguo } = require('./hongguo-drama/src/native/hongguo-search');
  const { browseList } = require('./hongguo-drama/src/native/catalog');

  const list = [];
  const seen = new Set();

  function addItem(item, defaultTag) {
    if (!item) return;
    const id = String(item.series_id || item.seriesId || '').trim();
    const title = String(item.series_title || item.title || '').trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.slice(0, 3) : [defaultTag];
    const total = Number(item.episode_count || item.episodeCount) || 80;
    list.push({
      id,
      title,
      titleKhmer: getKhmerTitle(title),
      cover: item.cover || item.series_cover || '',
      heat: item.heat || item.heatText || '',
      total,
      tags,
      category
    });
  }

  try {
    if (category === 'sad') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('虐恋', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('苦情', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('追妻', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '虐恋'));
      r2.results?.forEach(i => addItem(i, '苦情'));
      r3.results?.forEach(i => addItem(i, '追妻'));
    } else if (category === 'sweet') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('甜宠', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('先婚后爱', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('暗恋成真', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '甜宠'));
      r2.results?.forEach(i => addItem(i, '先婚后爱'));
      r3.results?.forEach(i => addItem(i, '暗恋成真'));
    } else if (category === 'romance') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'romance', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('爱情', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '爱情'));
      r2.results?.forEach(i => addItem(i, '都市爱情'));
    } else if (category === 'ceo') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('总裁', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('豪门', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('闪婚', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '总裁'));
      r2.results?.forEach(i => addItem(i, '豪门'));
      r3.results?.forEach(i => addItem(i, '闪婚'));
    } else if (category === 'comeback') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comeback', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('逆袭', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '逆袭'));
      r2.results?.forEach(i => addItem(i, '战神'));
    } else if (category === 'costume') {
      const [r1, r2, r3] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'costume', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('古装', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('穿越', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '古装'));
      r2.results?.forEach(i => addItem(i, '穿越'));
      r3.results?.forEach(i => addItem(i, '重生'));
    } else if (category === 'comedy') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comedy', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('喜剧', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '喜剧'));
      r2.results?.forEach(i => addItem(i, '搞笑'));
    } else if (category === 'family') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'family', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('家庭', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '家庭'));
      r2.results?.forEach(i => addItem(i, '婚姻'));
    } else if (category === 'suspense') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'suspense', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('悬疑', { page: pg }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '悬疑'));
      r2.results?.forEach(i => addItem(i, '惊悚'));
    }
  } catch (err) {
    console.error(`[Category ${category} p${pg}] Error:`, err.message);
  }

  categoryCache.set(cacheKey, { timestamp: Date.now(), dramas: list });
  console.log(`[Category ${category} (Page ${pg})] ទទួលបានរឿងចំនួន ${list.length} រឿង`);
  return list;
}

// Initial fetch & pre-warm top categories
refreshTrendingDramas().then(() => {
  // Pre-warm in background without blocking
  setTimeout(() => fetchCategoryDramas('sad'), 500);
  setTimeout(() => fetchCategoryDramas('sweet'), 1500);
  setTimeout(() => fetchCategoryDramas('ceo'), 2500);
  setTimeout(() => fetchCategoryDramas('romance'), 3500);
  setTimeout(() => fetchCategoryDramas('comeback'), 4500);
});

setInterval(() => {
  refreshTrendingDramas();
  categoryCache.clear();
}, 10 * 60 * 1000);

// Robust episode list fetcher with caching and curl fallback
async function fetchEpisodeListSafe(seriesId) {
  const sid = String(seriesId).trim();
  if (dramaCache.has(sid)) return dramaCache.get(sid);

  const localHtml = path.join(__dirname, 'detail_page.html');
  let html = '';

  try {
    const tempFile = path.join(__dirname, `temp_detail_${sid}.html`);
    await runCurlAsync(['-s', '-L', '-m', '15', `https://hongguoduanju.com/detail?series_id=${sid}`, '-o', tempFile]);
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
      html = fs.readFileSync(tempFile, 'utf8');
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  } catch (_) {}

  if (!html && fs.existsSync(localHtml) && sid === '7701328280862854168') {
    html = fs.readFileSync(localHtml, 'utf8');
  }

  if (html) {
    try {
      const router = readRouterData(html);
      const data = router.loaderData?.['player_(series_id)/page'] ?? router.loaderData?.['player_(series_id)/(vid)/page'] ?? router.loaderData?.detail_page;
      const detail = data?.seriesDetail;
      if (detail && Array.isArray(detail.vid_list)) {
        const result = {
          series_id: String(detail.series_id || sid),
          series_title: detail.series_name || 'Drama_' + sid,
          cover: detail.series_cover || '',
          episodes: detail.vid_list.map((vid, idx) => ({
            vid: String(vid),
            vid_index: idx + 1,
            title: `第${idx + 1}集`
          }))
        };
        dramaCache.set(sid, result);
        return result;
      }
    } catch (_) {}
  }

  const { fetchEpisodeList } = require('./hongguo-drama/src/native/hongguo');
  const res = await fetchEpisodeList(sid);
  dramaCache.set(sid, res);
  return res;
}

function broadcastProgress(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  progressClients.forEach(client => {
    try { client.res.write(message); } catch (_) {}
  });
}

function extractSeriesId(input) {
  if (!input) return null;
  const str = String(input).trim();
  const queryMatch = str.match(/series_id=(\d+)/);
  if (queryMatch) return queryMatch[1];
  const pathMatch = str.match(/\/(\d{15,30})\b/);
  if (pathMatch) return pathMatch[1];
  const digitsMatch = str.match(/\b\d{15,30}\b/);
  if (digitsMatch) return digitsMatch[0];
  return null;
}

async function smartResolve(input) {
  let seriesId = extractSeriesId(input);
  if (seriesId) {
    const info = await fetchEpisodeListSafe(seriesId);
    return {
      seriesId,
      title: info.series_title,
      cover: info.cover,
      total: info.episodes.length,
      episodes: info.episodes
    };
  }

  const searchRes = await searchHongguo(input);
  if (searchRes && searchRes.results && searchRes.results.length > 0) {
    const top = searchRes.results[0];
    const info = await fetchEpisodeListSafe(top.series_id);
    return {
      seriesId: top.series_id,
      title: info.series_title || top.series_title,
      cover: info.cover || top.cover,
      total: info.episodes.length || top.episode_count,
      episodes: info.episodes
    };
  }

  throw new Error('រកមិនឃើញរឿងតាមរយៈឈ្មោះ ឬ Link នេះទេ');
}

async function runBatchDownload(job) {
  const { seriesId, selectedEps, autoMerge, workers = 8 } = job;
  try {
    broadcastProgress({ type: 'global', status: 'info', message: 'កំពុងទាញយកព័ត៌មានភាគរឿង...', progress: 5 });
    const info = await fetchEpisodeListSafe(seriesId);
    const cleanTitle = (info.series_title || 'Drama_' + seriesId).replace(/[\\/:*?"<>|]/g, '_');
    const outputDir = path.join('D:\\HDRG', cleanTitle);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const totalEps = info.episodes.length;
    const ffmpegExe = path.join(__dirname, 'hongguo-drama', 'build', 'ffmpeg', 'ffmpeg.exe');

    const queue = selectedEps.map(num => {
      const epIndex = num - 1;
      return {
        epNum: num,
        epData: info.episodes[epIndex] || { vid_index: num }
      };
    });

    const activeConcurrency = Math.min(Math.max(1, Number(workers) || 8), queue.length);

    broadcastProgress({
      type: 'global',
      status: 'started',
      title: info.series_title,
      total: queue.length,
      workers: activeConcurrency,
      progress: 8,
      message: `🚀 ចាប់ផ្ដើមទាញយកចំនួន ${queue.length} ភាគ (Threads: ${activeConcurrency} Turbo)...`
    });

    const downloadedFiles = [];
    let completedCount = 0;
    let totalBytesDownloaded = 0;
    let queueIndex = 0;
    const downloadStartTime = Date.now();

    // High-speed URL Pre-fetch Pipeline (background prefetching so download workers never wait for API)
    const playUrlMap = new Map();
    let prefetchIndex = 0;
    async function prefetchWorker() {
      while (prefetchIndex < queue.length) {
        if (job.cancelled) return;
        const currentItem = queue[prefetchIndex++];
        if (!currentItem) break;
        const { epNum, epData } = currentItem;
        if (playUrlMap.has(epNum)) continue;
        try {
          const play = await fetchPlayUrlSingle(epData.vid, seriesId);
          if (play && play.url) playUrlMap.set(epNum, play);
        } catch (_) {}
      }
    }
    // Launch background prefetchers
    const prefetchWorkersCount = Math.min(3, queue.length);
    for (let p = 0; p < prefetchWorkersCount; p++) {
      prefetchWorker();
    }

    async function downloadWorker() {
      while (queueIndex < queue.length) {
        if (job.cancelled) return;
        const currentItem = queue[queueIndex++];
        if (!currentItem) break;

        const { epNum, epData } = currentItem;
        const padNum = String(epNum).padStart(String(totalEps).length, '0');
        const finalMp4 = path.join(outputDir, `${cleanTitle}_第${padNum}集.mp4`);
        const tempEncrypted = path.join(outputDir, `temp_ep_${epNum}_${Date.now()}.enc`);

        if (fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 500000) {
          downloadedFiles.push(finalMp4);
          completedCount++;
          const finalMb = (fs.statSync(finalMp4).size / (1024 * 1024)).toFixed(1);
          broadcastProgress({
            type: 'episode',
            epNum,
            status: 'done',
            size: finalMb + ' MB'
          });
          continue;
        }

        broadcastProgress({
          type: 'episode',
          epNum,
          status: 'downloading',
          percent: 20
        });

        const elapsedSec = Math.max(1, (Date.now() - downloadStartTime) / 1000);
        const currentSpeedMb = totalBytesDownloaded > 0 ? ((totalBytesDownloaded / (1024 * 1024)) / elapsedSec).toFixed(1) : '8.5';
        const remainingEps = queue.length - completedCount;
        const estRemainingSec = completedCount > 0 ? Math.round(remainingEps * (elapsedSec / completedCount)) : remainingEps * 2;

        broadcastProgress({
          type: 'global',
          status: 'progress',
          currentEp: epNum,
          completed: completedCount,
          total: queue.length,
          speed: currentSpeedMb + ' MB/s',
          eta: estRemainingSec,
          progress: Math.round(8 + (completedCount / queue.length) * 82),
          message: `🔥 កំពុងទាញយកភាគទី ${epNum}/${totalEps} (${completedCount}/${queue.length} ភាគចប់)...`
        });

        // Fast retrieval from prefetch cache or on-demand fetch
        let play = playUrlMap.get(epNum);
        if (!play) {
          try {
            play = await fetchPlayUrlSingle(epData.vid, seriesId);
            if (play && play.url) playUrlMap.set(epNum, play);
          } catch (err) {
            console.warn(`បរាជ័យ Link ភាគ ${epNum}:`, err.message);
            broadcastProgress({ type: 'episode', epNum, status: 'error' });
            continue;
          }
        }

        const urls = [
          ...(play.variants ? play.variants.map(v => v.url) : []),
          play.url
        ].filter(Boolean);

        urls.sort((a, b) => {
          const score = u => (u.includes('v3-') ? 3 : (u.includes('v26-') ? 2 : 1));
          return score(b) - score(a);
        });

        let success = false;
        for (const u of urls) {
          if (job.cancelled) break;
          try {
            broadcastProgress({ type: 'episode', epNum, status: 'downloading', percent: 45 });
            const ok = await runCurlAsync([
              '-s', '-L',
              '--tcp-fastopen',
              '--no-keepalive',
              '--compressed',
              '--connect-timeout', '8',
              '-m', '120',
              '--retry', '2',
              '--retry-delay', '1',
              '--retry-connrefused',
              u,
              '-o', tempEncrypted
            ]);
            if (ok && fs.existsSync(tempEncrypted) && fs.statSync(tempEncrypted).size > 500000) {
              success = true;
              break;
            }
          } catch (_) {}
        }

        if (job.cancelled) {
          if (fs.existsSync(tempEncrypted)) try { fs.unlinkSync(tempEncrypted); } catch (_) {}
          return;
        }

        if (!success) {
          broadcastProgress({ type: 'episode', epNum, status: 'error' });
          continue;
        }

        // Decrypt with FFmpeg
        broadcastProgress({ type: 'episode', epNum, status: 'downloading', percent: 85 });
        if (play.contentKey) {
          await new Promise((resolve) => {
            const child = spawn(ffmpegExe, [
              '-y', '-hide_banner', '-loglevel', 'error',
              '-decryption_key', play.contentKey,
              '-i', tempEncrypted,
              '-map', '0:v:0', '-map', '0:a?',
              '-c', 'copy',
              '-movflags', '+faststart',
              '-f', 'mp4', finalMp4
            ], { stdio: 'ignore' });
            child.on('close', resolve);
          });
        } else {
          fs.renameSync(tempEncrypted, finalMp4);
        }

        if (fs.existsSync(tempEncrypted)) {
          try { fs.unlinkSync(tempEncrypted); } catch (_) {}
        }

        if (fs.existsSync(finalMp4)) {
          downloadedFiles.push(finalMp4);
          completedCount++;
          const finalBytes = fs.statSync(finalMp4).size;
          totalBytesDownloaded += finalBytes;
          const finalMb = (finalBytes / (1024 * 1024)).toFixed(1);

          const liveElapsedSec = Math.max(1, (Date.now() - downloadStartTime) / 1000);
          const liveSpeedMb = ((totalBytesDownloaded / (1024 * 1024)) / liveElapsedSec).toFixed(1);
          const leftEps = queue.length - completedCount;
          const liveEtaSec = Math.round(leftEps * (liveElapsedSec / completedCount));

          broadcastProgress({
            type: 'episode',
            epNum,
            status: 'done',
            size: finalMb + ' MB'
          });
          broadcastProgress({
            type: 'global',
            status: 'progress',
            currentEp: epNum,
            completed: completedCount,
            total: queue.length,
            speed: liveSpeedMb + ' MB/s',
            eta: liveEtaSec,
            progress: Math.round(8 + (completedCount / queue.length) * 82),
            message: `✓ ភាគ ${epNum} រួចរាល់ (${finalMb} MB) | ល្បឿន: ${liveSpeedMb} MB/s | នៅសល់: ${leftEps} ភាគ`
          });
        }
      }
    }

    const workerPromises = [];
    for (let i = 0; i < activeConcurrency; i++) {
      workerPromises.push(downloadWorker());
    }
    await Promise.all(workerPromises);

    if (autoMerge && downloadedFiles.length > 1) {
      broadcastProgress({ type: 'global', status: 'merging', progress: 95, message: 'កំពុងផ្គុំគ្រប់ភាគទាំងអស់ចូលគ្នាជា Full Movie...' });
      const concatListFile = path.join(outputDir, 'concat_list.txt');
      const mergedOutput = path.join(outputDir, `${cleanTitle}_រឿងពេញចប់.mp4`);
      
      downloadedFiles.sort();
      const fileListContent = downloadedFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
      fs.writeFileSync(concatListFile, fileListContent);

      await new Promise(resolve => {
        const child = spawn(ffmpegExe, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'concat', '-safe', '0',
          '-i', concatListFile,
          '-c', 'copy',
          '-movflags', '+faststart',
          mergedOutput
        ], { stdio: 'ignore' });
        child.on('close', resolve);
      });

      if (fs.existsSync(concatListFile)) {
        try { fs.unlinkSync(concatListFile); } catch (_) {}
      }
    }

    broadcastProgress({
      type: 'global',
      status: 'done',
      progress: 100,
      outputDir,
      message: `🎉 ជោគជ័យ ១០០%! បានទាញយកចប់សព្វគ្រប់ចំនួន ${downloadedFiles.length} ភាគ! រក្សាទុកក្នុង D:\\HDRG`
    });

  } catch (err) {
    broadcastProgress({ type: 'global', status: 'error', message: 'កំហុស: ' + err.message });
  } finally {
    currentDownloadJob = null;
  }
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HDRG Pro Plus Studio - All-in-One Downloader</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎬</text></svg>">
  <style>
    :root {
      --bg-main: #0c1017;
      --bg-panel: #131b26;
      --bg-card: #182332;
      --bg-hover: #1f2d40;
      --primary: #3182ce;
      --accent-green: #38a169;
      --accent-orange: #dd6b20;
      --border: #233347;
      --text: #e2e8f0;
      --text-muted: #8899ac;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Khmer OS Siemreap", sans-serif; }
    body { background: var(--bg-main); color: var(--text); min-height: 100vh; overflow-x: hidden; display: flex; flex-direction: column; }
    
    /* Top Bar */
    .topbar { height: 60px; background: #090d14; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; gap: 14px; position: sticky; top: 0; z-index: 50; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: bold; font-size: 18px; color: #fff; }
    .brand-badge { background: linear-gradient(135deg, #e53e3e, #dd6b20); color: #fff; font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: bold; }
    
    .search-bar { flex: 1; max-width: 580px; display: flex; background: var(--bg-panel); border: 1.5px solid var(--border); border-radius: 8px; overflow: hidden; }
    .search-input { flex: 1; background: transparent; border: none; padding: 10px 14px; color: #fff; font-size: 14px; outline: none; }
    .search-btn { background: var(--primary); color: #fff; border: none; padding: 0 18px; cursor: pointer; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .search-btn:hover { background: #2b6cb0; }
    .btn-paste { background: #1a2636; border: none; color: #cbd5e0; padding: 0 14px; cursor: pointer; font-size: 13px; border-right: 1px solid var(--border); }
    .btn-paste:hover { background: #233347; color: #fff; }

    .top-actions { display: flex; gap: 10px; }
    .btn-folder { background: var(--bg-panel); border: 1.5px solid var(--border); color: #cbd5e0; padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 600; }
    .btn-folder:hover { background: var(--bg-hover); color: #fff; }

    /* Layout */
    .app-body { flex: 1; display: flex; }
    
    /* Left Panel: Multi-Genre Drama Library */
    .left-panel { width: 380px; background: var(--bg-panel); border-right: 1px solid var(--border); padding: 14px; display: flex; flex-direction: column; gap: 10px; height: calc(100vh - 60px); }
    .panel-top { display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    .panel-title { font-size: 15px; font-weight: 700; color: #fff; display: flex; justify-content: space-between; align-items: center; }
    .panel-subtitle { font-size: 11px; color: #63b3ed; display: flex; justify-content: space-between; align-items: center; }
    
    /* Category Filter Tabs */
    .category-tabs-wrap { overflow-x: auto; padding: 2px 0 6px 0; margin-top: 2px; }
    .category-tabs-wrap::-webkit-scrollbar { height: 4px; }
    .category-tabs-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .category-tabs { display: flex; gap: 6px; }
    .cat-tab { background: #182332; border: 1px solid var(--border); color: #a0aec0; padding: 5px 10px; border-radius: 16px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: 0.2s; display: flex; align-items: center; gap: 4px; }
    .cat-tab:hover { background: #233347; color: #fff; border-color: var(--primary); }
    .cat-tab.active { background: linear-gradient(135deg, #3182ce, #2b6cb0); color: #fff; border-color: #63b3ed; box-shadow: 0 2px 8px rgba(49, 130, 206, 0.4); }

    .library-search-input { width: 100%; background: #0c1017; border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; color: #fff; font-size: 12px; outline: none; }
    .library-search-input:focus { border-color: var(--primary); }

    .library-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
    
    /* Drama Mini Card with Badges */
    .drama-card-mini { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; gap: 10px; cursor: pointer; transition: 0.2s; position: relative; align-items: center; }
    .drama-card-mini:hover { border-color: var(--primary); transform: translateX(3px); background: var(--bg-hover); box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
    
    .rank-badge { position: absolute; top: 6px; left: 6px; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; z-index: 2; box-shadow: 0 2px 5px rgba(0,0,0,0.8); }
    .rank-gold { background: linear-gradient(135deg, #d69e2e, #b7791f); color: #fff; }
    .rank-silver { background: linear-gradient(135deg, #a0aec0, #718096); color: #fff; }
    .rank-bronze { background: linear-gradient(135deg, #dd6b20, #c05621); color: #fff; }
    .rank-normal { background: rgba(26, 54, 93, 0.85); color: #90cdf4; border: 1px solid #2b6cb0; }

    .badge-genre { background: rgba(49, 130, 206, 0.35); color: #90cdf4; border: 1px solid rgba(49, 130, 206, 0.7); }
    .badge-sad { background: rgba(229, 62, 62, 0.3); color: #feb2b2; border: 1px solid #e53e3e; }
    .badge-sweet { background: rgba(237, 100, 166, 0.3); color: #fbb6ce; border: 1px solid #ed64a6; }
    .badge-ceo { background: rgba(214, 158, 46, 0.3); color: #f6e05e; border: 1px solid #d69e2e; }
    .badge-comeback { background: rgba(72, 187, 120, 0.3); color: #9ae6b4; border: 1px solid #48bb78; }
    .badge-costume { background: rgba(159, 122, 234, 0.3); color: #d6bcfa; border: 1px solid #9f7aea; }
    .badge-comedy { background: rgba(237, 137, 54, 0.3); color: #fbd38d; border: 1px solid #ed8936; }
    .badge-family { background: rgba(56, 178, 172, 0.3); color: #81e6d9; border: 1px solid #38b2ac; }

    .mini-cover { width: 52px; height: 74px; border-radius: 6px; object-fit: cover; background: #0c1017; flex-shrink: 0; }
    .mini-info { display: flex; flex-direction: column; justify-content: center; overflow: hidden; flex: 1; }
    .mini-title { font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-khmer { font-size: 11px; color: #63b3ed; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-heat { font-size: 11px; color: #f6ad55; margin-bottom: 4px; }
    .mini-tags { display: flex; gap: 4px; flex-wrap: wrap; }
    .mini-tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(49, 130, 206, 0.2); color: #63b3ed; font-weight: 600; }

    /* Right Panel */
    .main-panel { flex: 1; padding: 20px 24px; display: flex; flex-direction: column; gap: 18px; height: calc(100vh - 60px); overflow-y: auto; }

    /* Drama Banner */
    .drama-banner { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px; display: flex; gap: 22px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
    .banner-cover { width: 120px; height: 165px; border-radius: 8px; object-fit: cover; background: #0c1017; box-shadow: 0 4px 12px rgba(0,0,0,0.5); flex-shrink: 0; }
    .banner-details { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
    .banner-title { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .banner-subtitle { font-size: 14px; color: #63b3ed; margin-bottom: 8px; }
    .banner-meta { display: flex; gap: 10px; font-size: 13px; color: var(--text-muted); margin-bottom: 14px; }
    
    /* Huge Download Action Bar */
    .download-bar { background: #0f1622; border: 1.5px solid #2b6cb0; border-radius: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .btn-download-giant { background: linear-gradient(135deg, #22543d, #2f855a); color: #fff; border: 1.5px solid #48bb78; padding: 14px 26px; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 10px; box-shadow: 0 4px 15px rgba(56, 161, 105, 0.4); transition: 0.2s; }
    .btn-download-giant:hover:not(:disabled) { background: linear-gradient(135deg, #2f855a, #38a169); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(56, 161, 105, 0.6); }
    .btn-test-ep { background: linear-gradient(135deg, #3182ce, #2b6cb0); color: #fff; border: none; padding: 14px 20px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: 0.2s; }
    .btn-test-ep:hover { background: #2b6cb0; transform: translateY(-1px); }
    .btn-stop-all { background: linear-gradient(135deg, #9b2c2c, #742a2a); border: 1.5px solid #e53e3e; color: #fff; padding: 14px 20px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: 0.2s; }
    .btn-stop-all:hover { background: linear-gradient(135deg, #c53030, #9b2c2c); transform: translateY(-1px); box-shadow: 0 4px 15px rgba(229, 62, 62, 0.4); }

    /* Turbo Speed Selector */
    .speed-selector-box { display: flex; align-items: center; gap: 8px; background: #0c1017; padding: 6px 12px; border-radius: 10px; border: 1px solid #233347; }
    .speed-pill-group { display: flex; gap: 6px; }
    .speed-pill { background: #141c2b; border: 1px solid #2b3b52; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; }
    .speed-pill:hover { background: #1e293b; color: #fff; }
    .speed-pill.active { background: linear-gradient(135deg, #2b6cb0, #3182ce); color: #fff; border-color: #63b3ed; box-shadow: 0 0 10px rgba(49, 130, 206, 0.4); }
    .speed-pill.turbo.active { background: linear-gradient(135deg, #c53030, #dd6b20); border-color: #f6ad55; box-shadow: 0 0 14px rgba(221, 107, 32, 0.6); }

    /* Live Progress Card (Visible when downloading) */
    .progress-card { background: #131d2a; border: 1.5px solid #38a169; border-radius: 14px; padding: 18px 22px; display: none; box-shadow: 0 8px 25px rgba(0,0,0,0.5); }
    .progress-bar-bg { width: 100%; height: 16px; background: #0c1017; border-radius: 8px; overflow: hidden; margin: 12px 0 8px 0; border: 1px solid var(--border); box-shadow: inset 0 2px 4px rgba(0,0,0,0.6); }
    .progress-bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #dd6b20, #38a169, #48bb78); transition: width 0.3s; box-shadow: 0 0 12px rgba(72, 187, 120, 0.6); }
    .btn-cancel-download { background: linear-gradient(135deg, #9b2c2c, #742a2a); border: 1px solid #e53e3e; color: #fff; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s; }
    .btn-cancel-download:hover { background: linear-gradient(135deg, #c53030, #9b2c2c); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(229, 62, 62, 0.5); }

    /* Guide Box */
    .guide-box { background: rgba(49, 130, 206, 0.1); border: 1px dashed #3182ce; border-radius: 10px; padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #bee3f8; }

    /* Episodes Section */
    .episodes-section { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
    .ep-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .ep-title { font-size: 16px; font-weight: 700; color: #fff; }
    .ep-tools { display: flex; gap: 8px; align-items: center; }
    .btn-ep-tool { background: var(--bg-card); border: 1px solid var(--border); color: #cbd5e0; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600; }
    .btn-ep-tool:hover { background: var(--bg-hover); color: #fff; }

    /* The Pills */
    .episodes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; max-height: 380px; overflow-y: auto; padding: 4px; }
    .ep-pill { height: 44px; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.15s; border: 1.5px solid var(--border); position: relative; }
    
    .ep-pill.done { background: #22543d; color: #9ae6b4; border-color: #38a169; }
    .ep-pill.downloading { background: #9c4221; color: #fff; border-color: #dd6b20; animation: pulse 0.8s infinite alternate; }
    .ep-pill.pending { background: #1a365d; color: #bee3f8; border-color: #3182ce; }
    .ep-pill.pending:hover { background: #2a4365; border-color: #63b3ed; transform: scale(1.03); }
    .ep-pill.unselected { background: #182332; color: #718096; border-color: #233347; opacity: 0.6; }
    .ep-subtext { font-size: 10px; font-weight: normal; margin-top: 1px; }

    @keyframes pulse {
      0% { opacity: 0.8; transform: scale(0.99); }
      100% { opacity: 1; transform: scale(1.02); }
    }
  </style>
</head>
<body>

  <!-- Top Bar -->
  <div class="topbar">
    <div class="brand">
      <span>🎬 HDRG PRO+</span>
      <span class="brand-badge">TOP 100 STUDIO</span>
    </div>

    <div class="search-bar">
      <button class="btn-paste" onclick="pasteClipboard()">📋 Paste</button>
      <input type="text" id="globalSearchInput" class="search-input" placeholder="វាយឈ្មោះរឿង (ឧ. 总裁) ឬ Series ID ឬ Link...">
      <button class="search-btn" onclick="handleSearch()">🔍 ស្វែងរក</button>
    </div>

    <div class="top-actions">
      <button class="btn-folder" onclick="openKeyModal()" style="border-color: #3182ce; color: #63b3ed; display: flex; align-items: center; gap: 6px;">
        <span id="keyStatusDot">⚪</span> 🔑 Gemini Key
      </button>
      <button class="btn-folder" onclick="downloadTool()" id="dlToolBtn" style="border-color: #48bb78; color: #68d391; display: flex; align-items: center; gap: 6px; position: relative; overflow: hidden;">
        <span id="dlToolIcon">⬇️</span> <span id="dlToolLabel">ទាញយក Tool</span>
        <span id="dlToolProgress" style="display:none; position:absolute; bottom:0; left:0; height:3px; background:#48bb78; width:0%; transition:width 0.3s;"></span>
      </button>
      <button class="btn-folder" id="openFolderBtn" onclick="openFolder()">📂 បើក Folder វីដេអូ</button>
    </div>
  </div>

  <div class="app-body">
    
    <!-- Left Panel: Multi-Genre Drama Library -->
    <div class="left-panel">
      <div class="panel-top">
        <div class="panel-title">
          <span id="libraryTitle">🔥 កំពុងល្បី (100 រឿង)</span>
          <button style="background: #2b6cb0; border: none; color: #fff; padding: 3px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 600;" onclick="reloadCurrentCategory(true)">
            <span id="refreshBtnText">🔄 Refresh</span>
          </button>
        </div>
        <div class="panel-subtitle">
          <span id="categoryDesc">Official Hongguo Rankings</span>
          <span id="categoryStats" style="color: #68d391; font-weight: 600;">100 រឿង</span>
        </div>

        <!-- Category Selector Tabs -->
        <div class="category-tabs-wrap">
          <div class="category-tabs" id="categoryTabs">
            <button class="cat-tab active" data-cat="trending" onclick="switchCategory('trending')">🔥 កំពុងល្បី (100)</button>
            <button class="cat-tab" data-cat="sad" onclick="switchCategory('sad')">😭 កម្សត់ / ទុក្ខ</button>
            <button class="cat-tab" data-cat="sweet" onclick="switchCategory('sweet')">💖 Sweet / ផ្អែម</button>
            <button class="cat-tab" data-cat="romance" onclick="switchCategory('romance')">🌹 រ៉ូមែនទិក</button>
            <button class="cat-tab" data-cat="ceo" onclick="switchCategory('ceo')">👑 CEO / អភិជន</button>
            <button class="cat-tab" data-cat="comeback" onclick="switchCategory('comeback')">⚔️ សងសឹក</button>
            <button class="cat-tab" data-cat="costume" onclick="switchCategory('costume')">⏳ បុរាណ / ឆ្លងភព</button>
            <button class="cat-tab" data-cat="comedy" onclick="switchCategory('comedy')">🎭 កំប្លែង</button>
            <button class="cat-tab" data-cat="family" onclick="switchCategory('family')">👨‍👩‍👧 គ្រួសារ</button>
            <button class="cat-tab" data-cat="suspense" onclick="switchCategory('suspense')">🔍 អាថ៌កំបាំង</button>
          </div>
        </div>

        <input type="text" id="librarySearch" class="library-search-input" placeholder="🔍 ស្វែងរកក្នុងប្រភេទនេះ..." oninput="filterLibrary()">
      </div>
      
      <div class="library-scroll" id="libraryList">
        <!-- Rendered by JS -->
      </div>
    </div>

    <!-- Main Panel -->
    <div class="main-panel">

      <!-- Drama Details -->
      <div class="drama-banner" id="mainBanner">
        <img id="bannerCover" class="banner-cover" src="https://p6-novel.byteimg.com/novel-pic/973dad4339e00fa9a5d1bf71e6431245~tplv-shrink:640:0.image">
        <div class="banner-details">
          <div>
            <h1 id="bannerTitle" class="banner-title">万妖图录传第十四季</h1>
            <p id="bannerKhmer" class="banner-subtitle">រឿងភាគខ្លីពិសេស</p>
            <div class="banner-meta">
              <span id="bannerId">Series ID: 7702763145030290457</span>
              <span>•</span>
              <span id="bannerTotal">សរុប: 202 ភាគ</span>
              <span>•</span>
              <span style="color: #68d391; font-weight: bold;">កម្រិត 1080p Full HD</span>
            </div>

            <!-- Gemini AI Zone -->
            <div id="geminiZone" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
              <!-- Gemini Translate Title Button -->
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <button id="btnGeminiTranslate" onclick="geminiTranslateTitle()"
                  style="background: linear-gradient(135deg, #1a56db, #7c3aed); border: none; color: #fff;
                  padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
                  display: flex; align-items: center; gap: 5px; font-family: inherit;">
                  🤖 Gemini បកប្រែចំណងជើង
                </button>
                <button id="btnGeminiSynopsis" onclick="geminiGetSynopsis()"
                  style="background: linear-gradient(135deg, #065f46, #0d9488); border: none; color: #fff;
                  padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
                  display: flex; align-items: center; gap: 5px; font-family: inherit;">
                  📖 AI ពន្យល់រឿង
                </button>
              </div>
              <!-- Gemini Result Box -->
              <div id="geminiResultBox" style="display:none; background: #0f1a2e; border: 1px solid #2d4a7a;
                border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #90cdf4; line-height: 1.7;
                max-height: 100px; overflow-y: auto; position: relative;">
                <span id="geminiResultText"></span>
                <button onclick="document.getElementById('geminiResultBox').style.display='none'"
                  style="position:absolute; top:4px; right:6px; background:none; border:none;
                  color:#718096; cursor:pointer; font-size:14px;">✕</button>
              </div>
            </div>
          </div>

          <!-- The Giant Download Action Buttons & Turbo Speed Selector -->
          <div class="download-bar">
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <button id="btnDownloadAll" class="btn-download-giant" onclick="downloadAllEpisodes()">
                🚀 ទាញយកគ្រប់ភាគទាំងអស់
              </button>
              <button id="btnCancelMain" class="btn-stop-all" onclick="stopDownload()">
                🛑 បោះបង់ (Cancel)
              </button>
              <button class="btn-test-ep" onclick="downloadSingleEpisode(2)">
                ⚡ សាកល្បងភាគ ២
              </button>
            </div>

            <div style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap;">
              <div class="speed-selector-box">
                <span style="font-size: 12px; color: #94a3b8; font-weight: 600;">⚡ ល្បឿន:</span>
                <div class="speed-pill-group">
                  <button type="button" class="speed-pill" onclick="setSpeed(6, this)">6 Threads</button>
                  <button type="button" class="speed-pill active" onclick="setSpeed(8, this)">🚀 8 Threads (ណែនាំ)</button>
                  <button type="button" class="speed-pill turbo" onclick="setSpeed(12, this)">🔥 12 Threads (Extreme)</button>
                </div>
              </div>
              <div style="font-size: 13px; color: #a0aec0; display: flex; align-items: center; gap: 6px;">
                <input type="checkbox" id="autoMergeCheck" checked>
                <label for="autoMergeCheck" style="cursor: pointer;">✨ ផ្គុំ Full Movie Auto</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Placeholder before any drama is selected -->
      <div id="noDramaPlaceholder" style="display: none; background: var(--bg-card); border: 2px dashed #233347; border-radius: 12px; padding: 60px 30px; text-align: center; color: #a0aec0; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 12px;">👈 🎬</div>
        <div style="font-size: 18px; font-weight: bold; color: #fff; margin-bottom: 8px;">សូមជ្រើសរើសរឿងភាគពីបញ្ជីខាងឆ្វេង ឬស្វែងរកខាងលើ</div>
        <div style="font-size: 13px; color: #718096;">ចុចលើរឿងណាមួយក្នុងប្រភេទ (🔥 កំពុងល្បី, 😭 កម្សត់, 💖 Sweet, 👑 CEO...) ដើម្បីផ្ទុកព័ត៌មាន និងទាញយក</div>
      </div>

      <!-- Live Progress Card (Visible when downloading) -->
      <div id="progressCard" class="progress-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #48bb78; box-shadow: 0 0 8px #48bb78;"></span>
            <span id="liveStatusText" style="color: #68d391; font-weight: bold; font-size: 14px;">🔥 កំពុងចាប់ផ្ដើមដំណើរការទាញយក...</span>
          </div>
          <button onclick="stopDownload()" class="btn-cancel-download">
            🛑 បោះបង់ (Cancel)
          </button>
        </div>

        <div class="progress-bar-bg">
          <div id="liveProgressBar" class="progress-bar-fill"></div>
        </div>

        <!-- Live Metrics Bar: Timer, Percent, Speed, ETA, Episode Count, Folder -->
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #cbd5e1; flex-wrap: wrap; gap: 8px; margin-top: 6px;">
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <span id="liveTimerText" style="color: #60a5fa; font-weight: 700; display: flex; align-items: center; gap: 4px; background: rgba(37,99,235,0.15); padding: 3px 8px; border-radius: 5px; border: 1px solid rgba(59,130,246,0.3);">
              ⏱️ <span>00:00</span>
            </span>
            <span id="liveSpeedText" style="color: #f6ad55; font-weight: 700; background: rgba(221,107,32,0.15); padding: 3px 8px; border-radius: 5px; border: 1px solid rgba(246,173,85,0.3);">
              ⚡ 8 Threads Turbo
            </span>
            <span id="liveEtaText" style="color: #cbd5e1; font-weight: 600; background: rgba(148,163,184,0.1); padding: 3px 8px; border-radius: 5px; border: 1px solid rgba(148,163,184,0.2);">
              ⏳ នៅសល់: ~-- វិនាទី
            </span>
            <span id="liveEpCountText" style="color: #9ae6b4; font-weight: 600;">
              📦 0 ភាគ
            </span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <span id="livePercentText" style="color: #fff; font-weight: 700; font-size: 16px;">0%</span>
            <button onclick="openFolder()" id="progressOpenFolderBtn" style="background: rgba(49, 130, 206, 0.2); border: 1px solid #3182ce; color: #90cdf4; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s;">📂 បើកមើល Folder</button>
          </div>
        </div>
      </div>

      <!-- Quick User Guide -->
      <div class="guide-box">
        💡 <b>របៀបចុចទាញយកងាយៗ (Quick Guide):</b><br>
        👉 <b>ជម្រើសទី ១ (ទាញយកទាំងអស់ Auto):</b> ចុចលើប៊ូតុងបៃតងធំខាងលើ <b>"🚀 ទាញយកគ្រប់ភាគទាំងអស់"</b><br>
        👉 <b>ជម្រើសទី ២ (ទាញយកតែ ១ ភាគដែលចង់បាន):</b> ចុចផ្ទាល់លើប្រអប់ភាគខាងក្រោម (ឧទាហរណ៍ ចុចលើ <b>EP02</b> ឬ <b>EP03</b>...) នោះប្រព័ន្ធនឹងចាប់ផ្ដើមទាញយកភាគនោះភ្លាមៗតែម្ដង!
      </div>

      <!-- Episodes Section -->
      <div class="episodes-section" id="episodesSection">
        <div class="ep-header">
          <div>
            <div class="ep-title">📋 បញ្ជីភាគរឿង (ចុចលើភាគណា ទាញយកភាគនោះភ្លាមៗ)</div>
            <div id="epStats" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">បានទាញយក: 2 ភាគ (ភាគ 1, 2 រួចរាល់) | នៅសល់: 78 ភាគ</div>
          </div>
          <div class="ep-tools">
            <button class="btn-ep-tool" onclick="selectAllEps(true)">☑ ជ្រើសទាំងអស់</button>
            <button class="btn-ep-tool" onclick="selectAllEps(false)">☐ លុបការជ្រើស</button>
          </div>
        </div>

        <div class="episodes-grid" id="episodesGrid">
          <!-- Rendered by JS -->
        </div>
      </div>

    </div>
  </div>

  <script>
    let currentDrama = null;
    let episodeStates = {}; // epNum -> 'done' | 'downloading' | 'pending' | 'unselected'
    let isDownloading = false;
    let currentCategory = 'trending';
    let categoryDramasMap = {}; // cat -> dramas array
    let allCurrentDramas = [];
    let refreshSecondsLeft = 600;

    const CAT_INFO = {
      trending: { title: '🔥 កំពុងល្បី (100 រឿង)', desc: 'Official Hongguo Rankings' },
      sad: { title: '😭 កម្សត់ & ទុក្ខសោក (Melodrama)', desc: 'រឿងសម្រក់ទឹកភ្នែក ឈឺចាប់ 虐恋 苦情' },
      sweet: { title: '💖 Sweet & ផ្អែមល្ហែម (Sweet Rom-com)', desc: 'រឿងផ្អែមល្ហែម ស្នេហាយកចិត្ត 甜宠 先婚后爱' },
      romance: { title: '🌹 ស្នេហារ៉ូមែនទិក (Romance Drama)', desc: 'រឿងមនោសញ្ចេតនាជ្រាលជ្រៅ 爱情' },
      ceo: { title: '👑 CEO & អភិជន (Billionaire Boss)', desc: 'លោកប្រធានផ្ដាច់ការ ត្រកូលអភិជន 总裁 豪门' },
      comeback: { title: '⚔️ សងសឹក & វាយបក (Comeback Revenge)', desc: 'អ្នកក្រក្លាយជាស្ដេច វាយបកយកឈ្នះ 逆袭 战神' },
      costume: { title: '⏳ ឆ្លងភព & បុរាណ (Historical / Time Travel)', desc: 'រឿងឆ្លងភព សម័យបុរាណ 古装 穿越 重生' },
      comedy: { title: '🎭 កំប្លែង & សប្បាយ (Comedy & Fun)', desc: 'រឿងសើចសប្បាយ បន្ធូរអារម្មណ៍ 喜剧 轻松' },
      family: { title: '👨‍👩‍👧 គ្រួសារ & ជីវិត (Family & Drama)', desc: 'រឿងទំនាស់គ្រួសារ សង្គមពិត 家庭 伦理' },
      suspense: { title: '🔍 អាថ៌កំបាំង & ព្រឺព្រួច (Mystery & Suspense)', desc: 'រឿងស៊ើបអង្កេត អាថ៌កំបាំង 悬疑 惊悚' }
    };

    let page = 1;
    let pageSize = 20;
    let displayedCount = 0;
    let currentVisibleDramas = [];
    let categoryPageMap = {}; // cat -> current page index from server
    let isLoadingMore = false;

    function handleCoverError(img) {
      img.onerror = null;
      img.src = 'https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image';
    }

    function selectDramaByIndex(idx) {
      const d = currentVisibleDramas[idx];
      if (!d) return;
      loadDrama(d.id, d.title, d.cover, d.total || 80, d.titleKhmer || d.title);
    }

    async function switchCategory(cat) {
      currentCategory = cat;
      displayedCount = 0;
      if (!categoryPageMap[cat]) categoryPageMap[cat] = 1;
      document.querySelectorAll('.cat-tab').forEach(t => {
        t.classList.toggle('active', t.getAttribute('data-cat') === cat);
      });

      const meta = CAT_INFO[cat] || { title: '🎬 DRAMA LIBRARY', desc: 'Hongguo Dramas' };
      document.getElementById('libraryTitle').innerText = meta.title;
      document.getElementById('categoryDesc').innerText = meta.desc;
      document.getElementById('librarySearch').value = '';

      await loadCategoryDramas(cat);
    }

    async function loadCategoryDramas(cat, force = false) {
      const container = document.getElementById('libraryList');
      if (categoryDramasMap[cat] && !force) {
        allCurrentDramas = categoryDramasMap[cat];
        displayedCount = Math.min(20, allCurrentDramas.length);
        renderLibraryCards(allCurrentDramas);
        return;
      }

      categoryPageMap[cat] = 1;
      container.innerHTML = '<div style="color: #718096; padding: 30px; text-align: center;">⏳ កំពុងទាញយកទិន្នន័យ...</div>';
      try {
        const query = '/api/catalog?category=' + cat + '&page=1' + (force ? '&refresh=1' : '');
        const res = await fetch(query);
        const data = await res.json();
        allCurrentDramas = data.dramas || [];
        categoryDramasMap[cat] = allCurrentDramas;
        displayedCount = Math.min(20, allCurrentDramas.length);
        renderLibraryCards(allCurrentDramas);
      } catch (err) {
        container.innerHTML = '<div style="color: #e53e3e; padding: 20px; text-align: center;">បរាជ័យក្នុងការទាញយក: ' + err.message + '</div>';
      }
    }

    async function reloadCurrentCategory(force = true) {
      document.getElementById('refreshBtnText').innerText = 'កំពុងទាញ...';
      categoryPageMap[currentCategory] = 1;
      await loadCategoryDramas(currentCategory, force);
      document.getElementById('refreshBtnText').innerText = '🔄 Refresh';
    }

    async function loadMoreDramas() {
      if (isLoadingMore) return;

      // 1. If we still have unrevealed dramas already stored in memory:
      if (displayedCount < allCurrentDramas.length) {
        displayedCount = Math.min(displayedCount + 20, allCurrentDramas.length);
        renderLibraryCards(allCurrentDramas);
        return;
      }

      // 2. If user reached the end of current list, fetch more from server endlessly!
      isLoadingMore = true;
      const btn = document.getElementById('btnLoadMoreDramas');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ កំពុងទាញយករឿងថ្មីៗបន្ថែម...</span>';
      }

      try {
        categoryPageMap[currentCategory] = (categoryPageMap[currentCategory] || 1) + 1;
        const nextPage = categoryPageMap[currentCategory];
        const res = await fetch('/api/catalog?category=' + currentCategory + '&page=' + nextPage);
        const data = await res.json();
        const newDramas = data.dramas || [];

        if (newDramas.length > 0) {
          const existingIds = new Set(allCurrentDramas.map(d => d.id));
          const fresh = newDramas.filter(d => !existingIds.has(d.id));
          if (fresh.length > 0) {
            allCurrentDramas = allCurrentDramas.concat(fresh);
            categoryDramasMap[currentCategory] = allCurrentDramas;
            displayedCount = Math.min(displayedCount + 20, allCurrentDramas.length);
          } else {
            // If page had duplicate results, try one page further
            categoryPageMap[currentCategory] = nextPage + 1;
            const res2 = await fetch('/api/catalog?category=' + currentCategory + '&page=' + (nextPage + 1));
            const data2 = await res2.json();
            const fresh2 = (data2.dramas || []).filter(d => !existingIds.has(d.id));
            if (fresh2.length > 0) {
              allCurrentDramas = allCurrentDramas.concat(fresh2);
              categoryDramasMap[currentCategory] = allCurrentDramas;
              displayedCount = Math.min(displayedCount + 20, allCurrentDramas.length);
            }
          }
        }
      } catch (err) {
        console.error('Failed to load more:', err);
      } finally {
        isLoadingMore = false;
        renderLibraryCards(allCurrentDramas);
      }
    }

    function renderLibraryCards(dramas) {
      const container = document.getElementById('libraryList');
      if (!dramas || dramas.length === 0) {
        container.innerHTML = '<div style="color: #718096; padding: 30px; text-align: center;">មិនមានរឿងក្នុងប្រភេទនេះទេ</div>';
        const statsEl = document.getElementById('categoryStats');
        if (statsEl) statsEl.innerText = '0 រឿង';
        return;
      }

      const q = document.getElementById('librarySearch').value.trim();
      const limit = q ? dramas.length : (displayedCount || 20);
      const visible = dramas.slice(0, limit);
      currentVisibleDramas = visible;

      const statsEl = document.getElementById('categoryStats');
      if (statsEl) statsEl.innerText = visible.length + '/' + dramas.length + '+ រឿង';

      const badgeMap = {
        sad: ['badge-sad', '😭 កម្សត់'],
        sweet: ['badge-sweet', '💖 Sweet'],
        romance: ['badge-genre', '🌹 រ៉ូមែនទិក'],
        ceo: ['badge-ceo', '👑 CEO'],
        comeback: ['badge-comeback', '⚔️ វាយបក'],
        costume: ['badge-costume', '⏳ បុរាណ'],
        comedy: ['badge-comedy', '🎭 កំប្លែង'],
        family: ['badge-family', '👨‍👩‍👧 គ្រួសារ'],
        suspense: ['badge-genre', '🔍 អាថ៌កំបាំង']
      };

      let cardsHtml = visible.map((d, idx) => {
        let badgeClass = 'badge-genre';
        let badgeLabel = '#' + (idx + 1);

        if (currentCategory === 'trending') {
          if (d.rank === 1) { badgeClass = 'rank-gold'; badgeLabel = '🥇 #1'; }
          else if (d.rank === 2) { badgeClass = 'rank-silver'; badgeLabel = '🥈 #2'; }
          else if (d.rank === 3) { badgeClass = 'rank-bronze'; badgeLabel = '🥉 #3'; }
          else { badgeClass = 'rank-normal'; badgeLabel = '#' + (d.rank || (idx + 1)); }
        } else if (badgeMap[currentCategory]) {
          badgeClass = badgeMap[currentCategory][0];
          badgeLabel = badgeMap[currentCategory][1];
        }

        const safeCover = d.cover || 'https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image';
        const totalEps = d.total || 80;

        return '<div class="drama-card-mini" onclick="selectDramaByIndex(' + idx + ')">' +
            '<div class="rank-badge ' + badgeClass + '">' + badgeLabel + '</div>' +
            '<img src="' + safeCover + '" class="mini-cover" loading="lazy" onerror="handleCoverError(this)">' +
            '<div class="mini-info">' +
              '<div class="mini-title">' + d.title + '</div>' +
              '<div class="mini-khmer">' + (d.titleKhmer || 'រឿងភាគខ្លីពិសេស') + '</div>' +
              '<div class="mini-heat">' + (d.heat ? '🔥 ' + d.heat : 'Hongguo Official') + '</div>' +
              '<div class="mini-tags">' +
                (d.tags || []).slice(0, 2).map(t => '<span class="mini-tag">' + t + '</span>').join('') +
                '<span class="mini-tag" style="background: rgba(56, 161, 105, 0.2); color: #9ae6b4;">' + totalEps + ' ភាគ</span>' +
              '</div>' +
            '</div>' +
          '</div>';
      }).join('');

      // Continuous Endless "Load More" Button: Never runs out!
      if (!q) {
        const remainingInMemory = dramas.length - visible.length;
        const btnText = remainingInMemory > 0
          ? '➕ មើលរឿងបន្ថែម (នៅសល់ ' + remainingInMemory + ' រឿងក្នុងបញ្ជី)'
          : '➕ ផ្ទុករឿងថ្មីៗបន្ថែមទៀត (ទាញយកបន្ត...)';

        cardsHtml += '<div style="padding: 14px 10px; text-align: center;">' +
            '<button id="btnLoadMoreDramas" onclick="loadMoreDramas()" style="width: 100%; background: linear-gradient(135deg, #1e3a8a, #2563eb); border: 1px solid #3b82f6; color: #fff; font-size: 13px; font-weight: bold; padding: 10px 16px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; font-family: inherit;">' +
              '<span>' + btnText + '</span>' +
            '</button>' +
          '</div>';
      }

      container.innerHTML = cardsHtml;
    }

    function filterLibrary() {
      const q = document.getElementById('librarySearch').value.toLowerCase().trim();
      if (!q) return renderLibraryCards(allCurrentDramas);
      const filtered = allCurrentDramas.filter(d => 
        d.title.toLowerCase().includes(q) || 
        (d.titleKhmer && d.titleKhmer.toLowerCase().includes(q)) || 
        (d.tags && d.tags.some(t => t.toLowerCase().includes(q)))
      );
      renderLibraryCards(filtered);
    }

    // Background Cache Refresh (Silent update every 10 mins without resetting user view)
    setInterval(() => {
      // Fetch fresh data in background without interrupting current UI
      fetch('/api/catalog?category=' + currentCategory + '&refresh=1').then(r => r.json()).then(data => {
        if (data && data.dramas) {
          categoryDramasMap[currentCategory] = data.dramas;
          allCurrentDramas = data.dramas;
        }
      }).catch(() => {});
    }, 10 * 60 * 1000);

    function renderEpisodesGrid() {
      const grid = document.getElementById('episodesGrid');
      let html = '';
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        const state = episodeStates[ep] || 'pending';
        let subText = '';
        if (state === 'done') subText = '✓ រួចរាល់';
        else if (state === 'downloading') subText = '⏳ កំពុងទាញ';
        else if (state === 'pending') subText = 'ចុចទាញយក';
        else subText = 'រំលង';

        html += '<div id="pill_ep_' + ep + '" class="ep-pill ' + state + '" onclick="handlePillClick(' + ep + ')">' +
            '<span>EP' + String(ep).padStart(2, '0') + '</span>' +
            '<span class="ep-subtext">' + subText + '</span>' +
          '</div>';
      }
      grid.innerHTML = html;
      updateStats();
    }

    // Direct 1-Click on any episode pill!
    function handlePillClick(ep) {
      if (episodeStates[ep] === 'done') {
        alert('ភាគទី ' + ep + ' នេះត្រូវបានទាញយករួចរាល់ហើយក្នុង Folder D:\\\\HDRG!');
        openFolder();
        return;
      }
      downloadSingleEpisode(ep);
    }

    function selectAllEps(select) {
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] !== 'done') {
          episodeStates[ep] = select ? 'pending' : 'unselected';
        }
      }
      renderEpisodesGrid();
    }

    function updateStats() {
      let done = 0;
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] === 'done') done++;
      }
      document.getElementById('epStats').innerText = 'បានទាញយក: ' + done + ' ភាគ | នៅសល់: ' + (currentDrama.total - done) + ' ភាគ';
    }

    async function loadDrama(id, title, cover, total, titleKhmer) {
      let totalEps = Number(total) || 0;
      currentDrama = { seriesId: id, title, cover, total: totalEps || 80, titleKhmer };

      // Reveal main panel sections
      const placeholder = document.getElementById('noDramaPlaceholder');
      if (placeholder) placeholder.style.display = 'none';
      const banner = document.getElementById('mainBanner');
      if (banner) banner.style.display = 'flex';
      const epSection = document.getElementById('episodesSection');
      if (epSection) epSection.style.display = 'block';

      document.getElementById('bannerTitle').innerText = title;
      document.getElementById('bannerKhmer').innerText = titleKhmer || title;
      document.getElementById('bannerCover').src = cover;
      document.getElementById('bannerId').innerText = 'Series ID: ' + id;
      const validInitialTotal = totalEps || 80;
      document.getElementById('bannerTotal').innerText = 'សរុប: ' + validInitialTotal + ' ភាគ';
      document.getElementById('btnDownloadAll').innerText = '🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ ' + validInitialTotal + ')';

      // Auto-translate banner Khmer title with Gemini in background
      autoGeminiTranslateTitle(title);

      // Dynamically fetch exact episode count & details from server
      try {
        fetch('/api/scanned-episodes?seriesId=' + id).then(r => r.json()).then(data => {
          if (data && data.total && data.total > 0 && data.total !== totalEps) {
            totalEps = data.total;
            currentDrama.total = totalEps;
            document.getElementById('bannerTotal').innerText = 'សរុប: ' + totalEps + ' ភាគ';
            document.getElementById('btnDownloadAll').innerText = '🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ ' + totalEps + ')';
            // Re-initialize episodes
            episodeStates = {};
            for (let i = 1; i <= totalEps; i++) episodeStates[i] = 'pending';
            if (data.downloaded && data.downloaded.length > 0) {
              data.downloaded.forEach(ep => { episodeStates[ep] = 'done'; });
            }
            renderEpisodesGrid();
          } else if (data && data.downloaded && data.downloaded.length > 0) {
            data.downloaded.forEach(ep => { episodeStates[ep] = 'done'; });
            renderEpisodesGrid();
          }
        }).catch(() => {});
      } catch (_) {}

      episodeStates = {};
      for (let i = 1; i <= currentDrama.total; i++) {
        episodeStates[i] = 'pending';
      }
      renderEpisodesGrid();
    }

    let activeEventSource = null;
    let downloadTimerInterval = null;
    let downloadSecondsElapsed = 0;

    function startDownloadTimer() {
      stopDownloadTimer();
      downloadSecondsElapsed = 0;
      const el = document.getElementById('liveTimerText');
      if (el) el.innerHTML = '⏱️ <span>00:00</span>';
      downloadTimerInterval = setInterval(() => {
        downloadSecondsElapsed++;
        const mins = String(Math.floor(downloadSecondsElapsed / 60)).padStart(2, '0');
        const secs = String(downloadSecondsElapsed % 60).padStart(2, '0');
        if (el) el.innerHTML = '⏱️ <span>' + mins + ':' + secs + '</span>';
      }, 1000);
    }

    function stopDownloadTimer() {
      if (downloadTimerInterval) {
        clearInterval(downloadTimerInterval);
        downloadTimerInterval = null;
      }
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (m === 0) return s + ' វិនាទី';
      return m + ' នាទី ' + s + ' វិនាទី';
    }

    let selectedWorkers = 8;
    function setSpeed(workers, btn) {
      selectedWorkers = Number(workers) || 8;
      document.querySelectorAll('.speed-pill').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const speedLabel = selectedWorkers >= 12 ? '🔥 12 Threads Extreme' : (selectedWorkers >= 8 ? '🚀 8 Threads Turbo' : '⚡ 6 Threads');
      const el = document.getElementById('liveSpeedText');
      if (el) el.innerText = speedLabel;
    }

    function connectSSE() {
      if (activeEventSource) {
        try { activeEventSource.close(); } catch (_) {}
      }
      activeEventSource = new EventSource('/api/progress');
      activeEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.status === 'cancelled') {
          stopDownloadTimer();
          if (activeEventSource) {
            try { activeEventSource.close(); } catch (_) {}
            activeEventSource = null;
          }
          isDownloading = false;
          document.getElementById('liveStatusText').innerText = '🛑 បានផ្អាក/បោះបង់ការទាញយក (ចំណាយពេល ' + formatTime(downloadSecondsElapsed) + ')';
          const validTotal = currentDrama ? (Number(currentDrama.total) || 80) : 80;
          document.getElementById('btnDownloadAll').innerText = '🚀 បន្តទាញយកគ្រប់ភាគ (ភាគ 1 ដល់ ' + validTotal + ')';
          document.getElementById('btnDownloadAll').disabled = false;
          for (let ep = 1; ep <= currentDrama.total; ep++) {
            if (episodeStates[ep] === 'downloading') episodeStates[ep] = 'pending';
          }
          renderEpisodesGrid();
          return;
        }

        if (data.type === 'episode') {
          episodeStates[data.epNum] = data.status;
          const pill = document.getElementById('pill_ep_' + data.epNum);
          if (pill) {
            pill.className = 'ep-pill ' + data.status;
            if (data.status === 'downloading') pill.children[1].innerText = (data.percent || 20) + '%';
            if (data.status === 'done') pill.children[1].innerText = '✓ រួចរាល់ (' + (data.size || '') + ')';
          }
          updateStats();
        }
        if (data.speed) {
          const spd = document.getElementById('liveSpeedText');
          if (spd) spd.innerText = '⚡ ' + data.speed;
        }
        if (data.eta !== undefined && data.eta !== null) {
          const etaEl = document.getElementById('liveEtaText');
          if (etaEl) etaEl.innerText = '⏳ នៅសល់: ~' + formatTime(data.eta);
        }
        if (data.completed !== undefined && data.total) {
          const epCountEl = document.getElementById('liveEpCountText');
          if (epCountEl) epCountEl.innerText = '📦 ' + data.completed + '/' + data.total + ' ភាគ';
        }
        if (data.type === 'global' || data.message) {
          document.getElementById('liveStatusText').innerText = data.message || 'កំពុងដំណើរការ...';
          if (data.progress !== undefined) {
            document.getElementById('liveProgressBar').style.width = data.progress + '%';
            document.getElementById('livePercentText').innerText = data.progress + '%';
          }
        }
        if (data.status === 'done' || data.status === 'completed') {
          stopDownloadTimer();
          isDownloading = false;
          const validTotal = currentDrama ? (Number(currentDrama.total) || 80) : 80;
          document.getElementById('btnDownloadAll').innerText = '🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ ' + validTotal + ')';
          document.getElementById('btnDownloadAll').disabled = false;
          document.getElementById('liveStatusText').innerText = '✅ បានទាញយកចប់គ្រប់ភាគដោយជោគជ័យ! (សរុប ' + formatTime(downloadSecondsElapsed) + ')';
          document.getElementById('liveProgressBar').style.width = '100%';
          document.getElementById('livePercentText').innerText = '100%';
          if (activeEventSource) {
            try { activeEventSource.close(); } catch (_) {}
            activeEventSource = null;
          }
        }
      };
    }

    function downloadAllEpisodes() {
      if (!currentDrama) return alert('សូមជ្រើសរើសរឿងជាមុនសិន!');
      const selectedEps = [];
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] !== 'done') selectedEps.push(ep);
      }
      if (selectedEps.length === 0) return alert('គ្រប់ភាគទាំងអស់ត្រូវបានទាញយករួចរាល់ហើយ!');

      triggerDownload(selectedEps);
    }

    function downloadSingleEpisode(ep) {
      if (!currentDrama) return alert('សូមជ្រើសរើសរឿងជាមុនសិន!');
      episodeStates[ep] = 'downloading';
      const pill = document.getElementById('pill_ep_' + ep);
      if (pill) {
        pill.className = 'ep-pill downloading';
        if (pill.children[1]) pill.children[1].innerText = '⏳ កំពុងទាញ...';
      }
      triggerDownload([ep]);
    }

    function triggerDownload(eps) {
      if (!currentDrama) return alert('សូមជ្រើសរើសរឿងជាមុនសិន!');
      isDownloading = true;
      document.getElementById('progressCard').style.display = 'block';

      const validTotal = Number(currentDrama.total) || 80;
      const labelText = eps.length === 1
        ? '⏳ កំពុងទាញភាគ ' + eps[0] + '... (ចុច 🛑 បោះបង់)'
        : '⏳ កំពុងទាញយក ' + eps.length + ' ភាគ (ភាគ 1 ដល់ ' + validTotal + ')...';
      document.getElementById('btnDownloadAll').innerText = labelText;
      document.getElementById('btnDownloadAll').disabled = true;

      // Start live ticking timer
      startDownloadTimer();

      document.getElementById('liveStatusText').innerText = eps.length === 1
        ? '🔥 កំពុងទាញយកភាគទី ' + eps[0] + '...'
        : '🔥 កំពុងចាប់ផ្ដើមទាញយកចំនួន ' + eps.length + ' ភាគ (Turbo Multi-threading)...';

      document.getElementById('liveEpCountText').innerText = eps.length === 1
        ? '📦 ភាគទី ' + eps[0]
        : '📦 0/' + eps.length + ' ភាគ';

      document.getElementById('liveProgressBar').style.width = '5%';
      document.getElementById('livePercentText').innerText = '5%';

      connectSSE();

      const autoMerge = document.getElementById('autoMergeCheck').checked;
      fetch('/api/start-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId: currentDrama.seriesId, selectedEps: eps, autoMerge, workers: selectedWorkers })
      });
    }

    async function stopDownload() {
      stopDownloadTimer();
      document.getElementById('liveStatusText').innerText = '⏳ កំពុងផ្អាក...';
      if (activeEventSource) {
        try { activeEventSource.close(); } catch (_) {}
        activeEventSource = null;
      }
      isDownloading = false;
      const validTotal = currentDrama ? (Number(currentDrama.total) || 80) : 80;
      document.getElementById('btnDownloadAll').innerText = '🚀 បន្តទាញយកគ្រប់ភាគ (ភាគ 1 ដល់ ' + validTotal + ')';
      document.getElementById('btnDownloadAll').disabled = false;

      if (currentDrama) {
        for (let ep = 1; ep <= currentDrama.total; ep++) {
          if (episodeStates[ep] === 'downloading') {
            episodeStates[ep] = 'pending';
          }
        }
        renderEpisodesGrid();
      }

      await fetch('/api/stop-download', { method: 'POST' });
      document.getElementById('liveStatusText').innerText = '🛑 បានបោះបង់/ផ្អាកការទាញយកដោយជោគជ័យ!';
    }

    async function openFolder() {
      const btn = document.getElementById('openFolderBtn');
      const origText = btn ? btn.innerText : '📂 បើក Folder វីដេអូ';
      if (btn) btn.innerText = '📂 កំពុងបើក...';

      const title = currentDrama ? currentDrama.title : '';
      try {
        await fetch('/api/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title })
        });
        if (btn) {
          btn.innerText = '✅ បានបើក Folder!';
          setTimeout(() => { if (btn) btn.innerText = origText; }, 2000);
        }
      } catch (err) {
        if (btn) {
          btn.innerText = '❌ បរាជ័យ';
          setTimeout(() => { if (btn) btn.innerText = origText; }, 2000);
        }
      }
    }

    async function handleSearch() {
      const input = document.getElementById('globalSearchInput').value.trim();
      if (!input) return alert('សូមបញ្ចូលឈ្មោះរឿង ឬ Link!');
      try {
        const res = await fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input })
        });
        const data = await res.json();
        if (data.success) {
          loadDrama(data.seriesId, data.title, data.cover, data.total, data.title);
        } else {
          alert('កំហុស: ' + (data.error || 'រកមិនឃើញរឿងនេះទេ'));
        }
      } catch (err) {
        alert('កំហុស: ' + err.message);
      }
    }

    async function pasteClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        document.getElementById('globalSearchInput').value = text;
        handleSearch();
      } catch (_) {
        alert('សូមចុច Ctrl+V ដើម្បីបិទភ្ជាប់');
      }
    }

    // Key Modal & Config Management
    function openKeyModal() {
      document.getElementById('keyModal').style.display = 'flex';
      fetch('/api/config').then(r => r.json()).then(data => {
        if (data.maskedKey) {
          document.getElementById('geminiKeyInput').placeholder = 'Key បច្ចុប្បន្ន: ' + data.maskedKey;
        }
      }).catch(() => {});
    }

    function closeKeyModal() {
      document.getElementById('keyModal').style.display = 'none';
      document.getElementById('keyFeedback').innerText = '';
    }

    function toggleKeyVisibility() {
      const input = document.getElementById('geminiKeyInput');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    async function testKeyNow() {
      const key = document.getElementById('geminiKeyInput').value.trim();
      const fb = document.getElementById('keyFeedback');
      fb.style.color = '#60a5fa';
      fb.innerText = '⏳ កំពុងតេស្តសាកល្បង Key ជាមួយ Google Gemini...';
      try {
        const res = await fetch('/api/test-gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.success) {
          fb.style.color = '#4ade80';
          fb.innerText = '✅ ' + data.message;
        } else {
          fb.style.color = '#f87171';
          fb.innerText = '❌ ' + (data.error || 'Key មិនត្រឹមត្រូវ');
        }
      } catch (err) {
        fb.style.color = '#f87171';
        fb.innerText = '❌ បរាជ័យក្នុងការតភ្ជាប់: ' + err.message;
      }
    }

    async function saveKeyNow() {
      const key = document.getElementById('geminiKeyInput').value.trim();
      if (!key) return alert('សូមបញ្ចូល API Key!');
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.success) {
          alert('✅ បានរក្សាទុក Gemini API Key ដោយជោគជ័យ (សមកាលកម្មទៅ D:\\HDRG និង D:\\EZARG)!');
          closeKeyModal();
          checkKeyStatus();
        } else {
          alert('កំហុស: ' + data.error);
        }
      } catch (err) {
        alert('កំហុស: ' + err.message);
      }
    }

    // ===== GEMINI AI FUNCTIONS =====
    function showGeminiResult(text, isLoading = false) {
      const box = document.getElementById('geminiResultBox');
      const span = document.getElementById('geminiResultText');
      box.style.display = 'block';
      span.innerHTML = isLoading
        ? '<span style="color:#a0aec0;">⏳ Gemini AI កំពុងគិត...</span>'
        : text;
    }

    // Auto translate title with Gemini in background when user clicks any drama
    async function autoGeminiTranslateTitle(title) {
      if (!title) return;
      try {
        const res = await fetch('/api/gemini-translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });
        const data = await res.json();
        if (data && data.khmer && !data.error) {
          const khmerElem = document.getElementById('bannerKhmer');
          if (khmerElem) khmerElem.innerText = data.khmer;
          if (currentDrama) currentDrama.titleKhmer = data.khmer;
        }
      } catch (_) {}
    }

    async function geminiTranslateTitle() {
      const title = document.getElementById('bannerTitle').innerText;
      if (!title) return;
      const btn = document.getElementById('btnGeminiTranslate');
      btn.disabled = true;
      btn.innerText = '⏳ កំពុង...';
      showGeminiResult('', true);
      try {
        const res = await fetch('/api/gemini-translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });
        const data = await res.json();
        if (data.error) {
          showGeminiResult('<span style="color:#fc8181;">❌ ' + data.error + '</span>');
        } else {
          // Update the Khmer subtitle with Gemini result
          document.getElementById('bannerKhmer').innerText = data.khmer;
          if (currentDrama) currentDrama.titleKhmer = data.khmer;
          showGeminiResult('✅ <b style="color:#68d391;">ចំណងជើងខ្មែរ:</b> ' + data.khmer);
        }
      } catch (err) {
        showGeminiResult('<span style="color:#fc8181;">❌ ' + err.message + '</span>');
      }
      btn.disabled = false;
      btn.innerText = '🤖 Gemini បកប្រែចំណងជើង';
    }

    async function geminiGetSynopsis() {
      const title = document.getElementById('bannerTitle').innerText;
      if (!title) return;
      const btn = document.getElementById('btnGeminiSynopsis');
      btn.disabled = true;
      btn.innerText = '⏳ កំពុង...';
      showGeminiResult('', true);
      try {
        const res = await fetch('/api/gemini-synopsis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });
        const data = await res.json();
        if (data.error) {
          showGeminiResult('<span style="color:#fc8181;">❌ ' + data.error + '</span>');
        } else {
          showGeminiResult('📖 <b style="color:#90cdf4;">ព្រឹត្តិការណ៍:</b> ' + data.synopsis);
        }
      } catch (err) {
        showGeminiResult('<span style="color:#fc8181;">❌ ' + err.message + '</span>');
      }
      btn.disabled = false;
      btn.innerText = '📖 AI ពន្យល់រឿង';
    }

    // ===== DOWNLOAD TOOL FUNCTION =====
    function downloadTool() {
      const btn = document.getElementById('dlToolBtn');
      const icon = document.getElementById('dlToolIcon');
      const label = document.getElementById('dlToolLabel');
      const bar = document.getElementById('dlToolProgress');

      // Start download immediately via hidden link
      const a = document.createElement('a');
      a.href = '/download/tool';
      a.download = 'hongguo-downloader-setup.exe';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Visual feedback: loading bar animation
      icon.innerText = '📦';
      label.innerText = 'កំពុង Save...';
      bar.style.display = 'block';
      bar.style.width = '0%';
      btn.style.cursor = 'default';

      let w = 0;
      const iv = setInterval(() => {
        w = Math.min(w + (Math.random() * 15), 90);
        bar.style.width = w + '%';
      }, 300);

      setTimeout(() => {
        clearInterval(iv);
        bar.style.width = '100%';
        icon.innerText = '✅';
        label.innerText = 'ទាញយករួច!';
        btn.style.borderColor = '#68d391';
        setTimeout(() => {
          icon.innerText = '⬇️';
          label.innerText = 'ទាញយក Tool';
          bar.style.display = 'none';
          bar.style.width = '0%';
          btn.style.cursor = 'pointer';
        }, 3000);
      }, 4000);
    }

    async function checkKeyStatus() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        const dot = document.getElementById('keyStatusDot');
        if (dot) {
          dot.innerText = data.hasKey ? '🟢' : '⚪';
          dot.title = data.hasKey ? 'Gemini Key: ' + data.maskedKey : 'មិនទាន់កំណត់ Key';
        }
      } catch (_) {}
    }

    window.onload = async () => {
      checkKeyStatus();
      try {
        await loadCategoryDramas('trending');
      } catch (e) {
        console.error('Error loading trending:', e);
      }
      if (allCurrentDramas && allCurrentDramas.length > 0) {
        const top1 = allCurrentDramas[0];
        try {
          loadDrama(top1.id, top1.title, top1.cover, top1.total, top1.titleKhmer);
        } catch (e) {
          console.error('Error loading top drama:', e);
        }
      }
    };
  </script>

  <!-- Modal API Key Settings -->
  <div id="keyModal" style="display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.75); z-index: 999; align-items: center; justify-content: center;">
    <div style="background: #111827; border: 1.5px solid #2b6cb0; border-radius: 14px; width: 520px; max-width: 90vw; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.8); display: flex; flex-direction: column; gap: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1f2937; padding-bottom: 12px;">
        <h3 style="font-size: 17px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px;">
          🔑 កំណត់ Google Gemini API Key
        </h3>
        <button onclick="closeKeyModal()" style="background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer;">✕</button>
      </div>

      <div style="font-size: 13px; color: #cbd5e1; line-height: 1.6;">
        Gemini API Key ប្រើប្រាស់សម្រាប់ **បកប្រែរឿងភាគចិនមកជាភាសាខ្មែរយ៉ាងរលូនបែបភាពយន្ត** (មិនរឹងដូច Google Translate)។<br>
        👉 <b>Free 100% (1,500 ភាគ/ថ្ងៃ)</b> អាចយក Key បាននៅ: <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color: #60a5fa; text-decoration: underline;">Google AI Studio</a>
      </div>

      <div>
        <label style="font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; display: block;">បញ្ចូល Gemini API Key របស់អ្នក (ឧ. AIzaSy...):</label>
        <div style="display: flex; background: #0f172a; border: 1px solid #334155; border-radius: 8px; overflow: hidden;">
          <input type="password" id="geminiKeyInput" placeholder="បិទភ្ជាប់ (Paste) Key នៅទីនេះ..." style="flex: 1; background: transparent; border: none; padding: 10px 14px; color: #fff; font-size: 13px; outline: none;">
          <button onclick="toggleKeyVisibility()" style="background: transparent; border: none; color: #94a3b8; padding: 0 12px; cursor: pointer; font-size: 13px;">👁️</button>
        </div>
        <div id="keyFeedback" style="font-size: 12px; margin-top: 6px; min-height: 18px;"></div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #1f2937; padding-top: 14px;">
        <button onclick="testKeyNow()" style="background: #1e293b; border: 1px solid #475569; color: #e2e8f0; padding: 9px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 600;">
          ⚡ សាកល្បង Key (Test)
        </button>
        <div style="display: flex; gap: 8px;">
          <button onclick="closeKeyModal()" style="background: transparent; border: 1px solid #374151; color: #9ca3af; padding: 9px 16px; border-radius: 8px; font-size: 13px; cursor: pointer;">បោះបង់</button>
          <button onclick="saveKeyNow()" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); border: none; color: #fff; padding: 9px 20px; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 700;">💾 រក្សាទុក (Save)</button>
        </div>
      </div>
    </div>
  </div>
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_CONTENT);
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎬</text></svg>');
  }

  // Config API: Get Key Status
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    const key = cfg.GEMINI_API_KEY || '';
    const masked = key ? key.slice(0, 6) + '...' + key.slice(-4) : '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      hasKey: Boolean(key),
      maskedKey: masked
    }));
  }

  // Config API: Save Key
  if (url.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { apiKey } = JSON.parse(body || '{}');
        const cfg = loadConfig();
        cfg.GEMINI_API_KEY = (apiKey || '').trim();
        saveConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, hasKey: Boolean(cfg.GEMINI_API_KEY) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Test Gemini Key API
  if (url.pathname === '/api/test-gemini' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { apiKey } = JSON.parse(body || '{}');
        const key = (apiKey || loadConfig().GEMINI_API_KEY || '').trim();
        if (!key) throw new Error('សូមបញ្ចូល API Key ជាមុនសិន!');
        const text = await testGeminiKey(key);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, message: `Key ត្រឹមត្រូវ និងដំណើរការល្អ! (តេស្តបកប្រែ: ${text})` }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: 'Key មិនត្រឹមត្រូវ ឬមានបញ្ហា: ' + err.message }));
      }
    });
    return;
  }

  // Categories list API
  if (url.pathname === '/api/categories') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ categories: CATEGORIES }));
  }

  // Multi-Category Catalog API
  if (url.pathname === '/api/catalog') {
    const category = url.searchParams.get('category') || 'trending';
    const force = url.searchParams.get('refresh') === '1';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const dramas = await fetchCategoryDramas(category, page, force);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      category,
      page,
      count: dramas.length,
      dramas,
      nextRefreshIn: Math.max(0, Math.round((nextRefreshTimestamp - Date.now()) / 1000))
    }));
  }

  // Top 100 Trending API (compatibility)
  if (url.pathname === '/api/trending') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      dramas: cachedTrendingDramas,
      nextRefreshIn: Math.max(0, Math.round((nextRefreshTimestamp - Date.now()) / 1000))
    }));
  }

  // Force Refresh Category API
  if (url.pathname === '/api/refresh-trending' && req.method === 'POST') {
    await refreshTrendingDramas();
    categoryCache.clear();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      success: true,
      count: cachedTrendingDramas.length,
      dramas: cachedTrendingDramas
    }));
  }

  // Scanned episodes API
  if (url.pathname === '/api/scanned-episodes') {
    const sid = url.searchParams.get('seriesId');
    try {
      const info = await fetchEpisodeListSafe(sid);
      const cleanTitle = (info.series_title || 'Drama_' + sid).replace(/[\\/:*?"<>|]/g, '_');
      const outputDir = path.join('D:\\HDRG', cleanTitle);
      const downloaded = [];
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir);
        files.forEach(f => {
          const m = f.match(/_第(\d+)集\.mp4$/);
          if (m) {
            const ep = parseInt(m[1], 10);
            const size = fs.statSync(path.join(outputDir, f)).size;
            if (size > 500000) downloaded.push(ep);
          }
        });
      }
      const actualTotal = Array.isArray(info.episodes) ? info.episodes.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        total: actualTotal,
        title: info.series_title,
        downloaded
      }));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total: 0, downloaded: [] }));
    }
  }

  if (url.pathname === '/api/progress') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: {"type":"init","message":"⚡ បានភ្ជាប់ប្រព័ន្ធទាញយកល្បឿនលឿន (Turbo Multi-threaded)"}\n\n');
    const clientId = Date.now();
    const newClient = { id: clientId, res };
    progressClients.push(newClient);

    req.on('close', () => {
      progressClients = progressClients.filter(c => c.id !== clientId);
    });
    return;
  }

  if (url.pathname === '/api/resolve' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { input } = JSON.parse(body || '{}');
        const resolved = await smartResolve(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          seriesId: resolved.seriesId,
          title: resolved.title,
          cover: resolved.cover,
          total: resolved.total
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/start-download' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { seriesId, selectedEps, autoMerge, workers } = JSON.parse(body || '{}');
        currentDownloadJob = { seriesId, selectedEps, autoMerge, workers, cancelled: false };
        runBatchDownload(currentDownloadJob);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/stop-download' && req.method === 'POST') {
    if (currentDownloadJob) currentDownloadJob.cancelled = true;
    try {
      exec('taskkill /F /IM curl.exe /T', () => {});
      exec('taskkill /F /IM ffmpeg.exe /T', () => {});
    } catch (_) {}
    broadcastProgress({ type: 'global', status: 'cancelled', message: '🛑 បានផ្អាកការទាញយកដោយជោគជ័យ' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (url.pathname === '/api/open-folder') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let targetPath = 'D:\\HDRG';
      try {
        const { title } = JSON.parse(body || '{}');
        if (title) {
          const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '_');
          const dramaDir = path.join('D:\\HDRG', cleanTitle);
          if (fs.existsSync(dramaDir)) {
            targetPath = dramaDir;
          }
        }
      } catch (_) {}

      try {
        if (!fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
        }
        const p = spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
        p.unref();
      } catch (err) {
        try { exec(`start "" "${targetPath}"`); } catch (_) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true, path: targetPath }));
    });
    return;
  }

  // Download Tool: serve setup.exe directly to browser
  if (url.pathname === '/download/tool') {
    const exeDir = __dirname;
    // Find the first .exe file in the HDRG folder
    const exeFiles = fs.readdirSync(exeDir).filter(f => f.endsWith('.exe'));
    if (exeFiles.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'មិនរកឃើញ setup.exe' }));
    }
    const exeFile = exeFiles[0];
    const exePath = path.join(exeDir, exeFile);
    const stat = fs.statSync(exePath);
    const fileName = encodeURIComponent(exeFile);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${exeFile}"; filename*=UTF-8''${fileName}`,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    const readStream = fs.createReadStream(exePath);
    readStream.on('error', (err) => {
      console.error('Error streaming exe:', err.message);
    });
    return readStream.pipe(res);
  }

  // ===== GEMINI: Translate Drama Title Chinese → Khmer =====
  if (url.pathname === '/api/gemini-translate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { title } = JSON.parse(body || '{}');
        if (!title) { res.writeHead(400); return res.end(JSON.stringify({ error: 'title required' })); }
        const prompt = `You are a Khmer drama translator. Translate this Chinese drama title to natural Khmer language (ភាសាខ្មែរ). 
Return ONLY the Khmer translation, no explanation, no Chinese characters, no romanization.
Chinese title: "${title}"
Khmer translation:`;
        const khmer = await callGemini(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ khmer }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ===== GEMINI: Drama Synopsis in Khmer =====
  if (url.pathname === '/api/gemini-synopsis' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { title } = JSON.parse(body || '{}');
        if (!title) { res.writeHead(400); return res.end(JSON.stringify({ error: 'title required' })); }
        const prompt = `You are a Khmer drama expert. Based on this Chinese drama title, write a short 2-3 sentence synopsis in natural Khmer language (ភាសាខ្មែរ).
Make it sound like a real drama description. Return ONLY Khmer text.
Drama title: "${title}"
Khmer synopsis:`;
        const synopsis = await callGemini(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ synopsis }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ===== GEMINI API HELPER (HTTPS call) =====
const https = require('https');
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash'
];

async function testGeminiKey(apiKey) {
  if (!apiKey) throw new Error('សូមបញ្ចូល API Key!');
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      return await callGeminiModel(model, apiKey, "Translate '你好' to Khmer in 1 word.");
    } catch (err) {
      lastError = err;
      const m = err.message || '';
      if (m.includes('API_KEY_INVALID') || m.includes('API key not valid')) {
        throw err;
      }
    }
  }
  throw lastError;
}

async function callGemini(prompt) {
  const cfg = loadConfig();
  const apiKey = cfg.GEMINI_API_KEY;
  if (!apiKey) throw new Error('មិនទាន់ដាក់ Gemini API Key — ចុច 🔑 Gemini Key ក្នុង topbar');

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const result = await callGeminiModel(model, apiKey, prompt);
      return result;
    } catch (err) {
      lastError = err;
      const m = err.message || '';
      if (m.includes('API_KEY_INVALID') || m.includes('API key not valid')) {
        throw err;
      }
      console.warn(`[Gemini Fallback] Model ${model} failed: ${m.slice(0, 80)}. Trying next model...`);
    }
  }
  throw lastError;
}

function callGeminiModel(model, apiKey, prompt) {
  const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`);
  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 10000
    };
    const reqG = https.request(options, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || 'Gemini API error'));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    reqG.on('timeout', () => {
      reqG.destroy();
      reject(new Error(`Model ${model} request timed out after 10s`));
    });
    reqG.on('error', reject);
    reqG.write(bodyStr);
    reqG.end();
  });
}

server.listen(PORT, () => {
  console.log(`HDRG Pro Plus Downloader running at: http://localhost:${PORT}`);
});
