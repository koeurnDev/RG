const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync, exec } = require('child_process');
const { fetchPlayUrlSingle } = require('./hongguo-drama/src/native/hongguo');
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
              allDramas.push({
                id: String(item.seriesId),
                title: String(item.title || 'Drama'),
                titleKhmer: getKhmerTitle(item.title),
                cover: item.cover || '',
                heat: item.heatText || '',
                total: 80,
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

async function fetchCategoryDramas(category, force = false) {
  if (category === 'trending') {
    if (force || cachedTrendingDramas.length === 0) await refreshTrendingDramas();
    return cachedTrendingDramas;
  }

  if (!force && categoryCache.has(category)) {
    const cached = categoryCache.get(category);
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
        searchHongguo('虐恋', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('苦情', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('追妻', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '虐恋'));
      r2.results?.forEach(i => addItem(i, '苦情'));
      r3.results?.forEach(i => addItem(i, '追妻'));
    } else if (category === 'sweet') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('甜宠', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('先婚后爱', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('暗恋成真', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '甜宠'));
      r2.results?.forEach(i => addItem(i, '先婚后爱'));
      r3.results?.forEach(i => addItem(i, '暗恋成真'));
    } else if (category === 'romance') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'romance', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('爱情', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '爱情'));
      r2.results?.forEach(i => addItem(i, '都市爱情'));
    } else if (category === 'ceo') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('总裁', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('豪门', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('闪婚', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '总裁'));
      r2.results?.forEach(i => addItem(i, '豪门'));
      r3.results?.forEach(i => addItem(i, '闪婚'));
    } else if (category === 'comeback') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comeback', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('逆袭', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '逆袭'));
      r2.results?.forEach(i => addItem(i, '战神'));
    } else if (category === 'costume') {
      const [r1, r2, r3] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'costume', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('古装', { page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('穿越', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '古装'));
      r2.results?.forEach(i => addItem(i, '穿越'));
      r3.results?.forEach(i => addItem(i, '重生'));
    } else if (category === 'comedy') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comedy', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('喜剧', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '喜剧'));
      r2.results?.forEach(i => addItem(i, '搞笑'));
    } else if (category === 'family') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'family', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('家庭', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '家庭'));
      r2.results?.forEach(i => addItem(i, '婚姻'));
    } else if (category === 'suspense') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'suspense', page: 1 }).catch(() => ({ results: [] })),
        searchHongguo('悬疑', { page: 1 }).catch(() => ({ results: [] }))
      ]);
      r1.results?.forEach(i => addItem(i, '悬疑'));
      r2.results?.forEach(i => addItem(i, '惊悚'));
    }
  } catch (err) {
    console.error(`[Category ${category}] Error:`, err.message);
  }

  categoryCache.set(category, { timestamp: Date.now(), dramas: list });
  console.log(`[Category ${category}] ទទួលបានរឿងចំនួន ${list.length} រឿង`);
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
    execSync(`curl.exe -s -L -m 15 "https://hongguoduanju.com/detail?series_id=${sid}" -o "${tempFile}"`);
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
      html = fs.readFileSync(tempFile, 'utf8');
      fs.unlinkSync(tempFile);
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
  const { seriesId, selectedEps, autoMerge, workers = 4 } = job;
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

    broadcastProgress({
      type: 'global',
      status: 'started',
      title: info.series_title,
      total: queue.length,
      progress: 10,
      message: `ចាប់ផ្ដើមទាញយកចំនួន ${queue.length} ភាគ (Threads: ${workers})...`
    });

    const downloadedFiles = [];
    let completedCount = 0;
    let queueIndex = 0;

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
          broadcastProgress({
            type: 'episode',
            epNum,
            status: 'done',
            size: (fs.statSync(finalMp4).size / (1024 * 1024)).toFixed(1) + ' MB'
          });
          continue;
        }

        broadcastProgress({
          type: 'episode',
          epNum,
          status: 'downloading',
          percent: 20
        });

        broadcastProgress({
          type: 'global',
          status: 'progress',
          currentEp: epNum,
          progress: Math.round(10 + (completedCount / queue.length) * 80),
          message: `🔥 កំពុងទាញយកភាគទី ${epNum}/${totalEps}...`
        });

        let play;
        try {
          play = await fetchPlayUrlSingle(epData.vid, seriesId);
        } catch (err) {
          console.warn(`បរាជ័យ Link ភាគ ${epNum}:`, err.message);
          broadcastProgress({ type: 'episode', epNum, status: 'error' });
          continue;
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
            execSync(`curl.exe -s -L --connect-timeout 8 -m 120 "${u}" -o "${tempEncrypted}"`);
            if (fs.existsSync(tempEncrypted) && fs.statSync(tempEncrypted).size > 500000) {
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
          const finalMb = (fs.statSync(finalMp4).size / (1024 * 1024)).toFixed(1);
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
            progress: Math.round(10 + (completedCount / queue.length) * 80),
            message: `✓ បានទាញយកចប់ភាគទី ${epNum} (${finalMb} MB)!`
          });
        }
      }
    }

    const workerPromises = [];
    const concurrency = Math.min(workers, queue.length);
    for (let i = 0; i < concurrency; i++) {
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
    .btn-download-giant { background: linear-gradient(135deg, #38a169, #276749); color: #fff; border: none; padding: 14px 26px; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 10px; box-shadow: 0 4px 15px rgba(56, 161, 105, 0.4); transition: 0.2s; }
    .btn-download-giant:hover { background: linear-gradient(135deg, #2f855a, #22543d); transform: translateY(-2px); }
    .btn-test-ep { background: linear-gradient(135deg, #3182ce, #2b6cb0); color: #fff; border: none; padding: 14px 20px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; }
    .btn-test-ep:hover { background: #2b6cb0; }
    .btn-stop-all { background: #c53030; color: #fff; border: none; padding: 14px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn-stop-all:hover { background: #9b2c2c; }

    /* Live Progress Card (Visible when downloading) */
    .progress-card { background: #1a2230; border: 1.5px solid #38a169; border-radius: 12px; padding: 16px 20px; display: none; }
    .progress-bar-bg { width: 100%; height: 14px; background: #0c1017; border-radius: 7px; overflow: hidden; margin: 10px 0; border: 1px solid var(--border); }
    .progress-bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #dd6b20, #38a169); transition: width 0.3s; }

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
      <input type="text" id="globalSearchInput" class="search-input" placeholder="វាយឈ្មោះរឿង (ឧ. 装穷提亲) ឬ Series ID ឬ Link..." value="7701328280862854168">
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
      <button class="btn-folder" onclick="openFolder()">📂 បើក Folder វីដេអូ</button>
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
          <span>ប្តូរថ្មីក្នុង: <b id="timerCountdown" style="color: #68d391;">10:00</b></span>
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
      <div class="drama-banner">
        <img id="bannerCover" class="banner-cover" src="https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image">
        <div class="banner-details">
          <div>
            <h1 id="bannerTitle" class="banner-title">装穷提亲，娶到全家嫌弃的她</h1>
            <p id="bannerKhmer" class="banner-subtitle">បន្លំធ្វើជាអ្នកក្រទៅស្តីដណ្តឹង រៀបការជាមួយនារីដែលគ្រួសារមើលងាយ</p>
            <div class="banner-meta">
              <span id="bannerId">Series ID: 7701328280862854168</span>
              <span>•</span>
              <span id="bannerTotal">សរុប: 80 ភាគ</span>
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

          <!-- The Giant Download Action Buttons -->
          <div class="download-bar">
            <button id="btnDownloadAll" class="btn-download-giant" onclick="downloadAllEpisodes()">
              🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ 80)
            </button>
            <button class="btn-test-ep" onclick="downloadSingleEpisode(2)">
              ⚡ សាកល្បងទាញយកភាគ ២ ឥឡូវនេះ
            </button>
            <button class="btn-stop-all" onclick="stopDownload()">
              ⏹ ផ្អាក (Stop)
            </button>
            <div style="font-size: 13px; color: #a0aec0; display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="autoMergeCheck" checked>
              <label for="autoMergeCheck" style="cursor: pointer;">✨ ផ្គុំ Full Movie Auto</label>
            </div>
          </div>
        </div>
      </div>

      <!-- Live Progress Card (Visible when downloading) -->
      <div id="progressCard" class="progress-card">
        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 14px;">
          <span id="liveStatusText" style="color: #68d391;">🔥 កំពុងចាប់ផ្ដើមដំណើរការទាញយក...</span>
          <span id="livePercentText" style="color: #fff;">0%</span>
        </div>
        <div class="progress-bar-bg">
          <div id="liveProgressBar" class="progress-bar-fill"></div>
        </div>
        <div style="font-size: 12px; color: #a0aec0;">វីដេអូនីមួយៗនឹងរក្សាទុកក្នុង Folder: <b>D:\\HDRG</b></div>
      </div>

      <!-- Quick User Guide -->
      <div class="guide-box">
        💡 <b>របៀបចុចទាញយកងាយៗ (Quick Guide):</b><br>
        👉 <b>ជម្រើសទី ១ (ទាញយកទាំងអស់ Auto):</b> ចុចលើប៊ូតុងបៃតងធំខាងលើ <b>"🚀 ទាញយកគ្រប់ភាគទាំងអស់"</b><br>
        👉 <b>ជម្រើសទី ២ (ទាញយកតែ ១ ភាគដែលចង់បាន):</b> ចុចផ្ទាល់លើប្រអប់ភាគខាងក្រោម (ឧទាហរណ៍ ចុចលើ <b>EP02</b> ឬ <b>EP03</b>...) នោះប្រព័ន្ធនឹងចាប់ផ្ដើមទាញយកភាគនោះភ្លាមៗតែម្ដង!
      </div>

      <!-- Episodes Section -->
      <div class="episodes-section">
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
    let currentDrama = {
      seriesId: '7701328280862854168',
      title: '装穷提亲，娶到全家嫌弃的她',
      titleKhmer: 'បន្លំធ្វើជាអ្នកក្រទៅស្តីដណ្តឹង រៀបការជាមួយនារីដែលគ្រួសារមើលងាយ',
      cover: 'https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image',
      total: 80
    };
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

    async function switchCategory(cat) {
      currentCategory = cat;
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
        renderLibraryCards(allCurrentDramas);
        return;
      }

      container.innerHTML = '<div style="color: #718096; padding: 30px; text-align: center;">⏳ កំពុងទាញយកទិន្នន័យ...</div>';
      try {
        const res = await fetch(\`/api/catalog?category=\${cat}\${force ? '&refresh=1' : ''}\`);
        const data = await res.json();
        allCurrentDramas = data.dramas || [];
        categoryDramasMap[cat] = allCurrentDramas;
        if (data.nextRefreshIn) refreshSecondsLeft = data.nextRefreshIn;
        renderLibraryCards(allCurrentDramas);
      } catch (err) {
        container.innerHTML = \`<div style="color: #e53e3e; padding: 20px; text-align: center;">បរាជ័យក្នុងការទាញយក: \${err.message}</div>\`;
      }
    }

    async function reloadCurrentCategory(force = true) {
      document.getElementById('refreshBtnText').innerText = 'កំពុងទាញ...';
      await loadCategoryDramas(currentCategory, force);
      document.getElementById('refreshBtnText').innerText = '🔄 Refresh';
    }

    function renderLibraryCards(dramas) {
      const container = document.getElementById('libraryList');
      if (!dramas || dramas.length === 0) {
        container.innerHTML = '<div style="color: #718096; padding: 30px; text-align: center;">មិនមានរឿងក្នុងប្រភេទនេះទេ</div>';
        return;
      }

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

      container.innerHTML = dramas.map((d, idx) => {
        let badgeClass = 'badge-genre';
        let badgeLabel = \`#\${idx + 1}\`;

        if (currentCategory === 'trending') {
          if (d.rank === 1) { badgeClass = 'rank-gold'; badgeLabel = '🥇 #1'; }
          else if (d.rank === 2) { badgeClass = 'rank-silver'; badgeLabel = '🥈 #2'; }
          else if (d.rank === 3) { badgeClass = 'rank-bronze'; badgeLabel = '🥉 #3'; }
          else { badgeClass = 'rank-normal'; badgeLabel = \`#\${d.rank || idx + 1}\`; }
        } else if (badgeMap[currentCategory]) {
          badgeClass = badgeMap[currentCategory][0];
          badgeLabel = badgeMap[currentCategory][1];
        }

        const safeTitle = (d.title || 'Drama').replace(/'/g, "\\\\'");
        const safeKhmer = (d.titleKhmer || d.title || '').replace(/'/g, "\\\\'");
        const safeCover = d.cover || 'https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image';
        const totalEps = d.total || 80;

        return \`
          <div class="drama-card-mini" onclick="loadDrama('\${d.id}', '\${safeTitle}', '\${safeCover}', \${totalEps}, '\${safeKhmer}')">
            <div class="rank-badge \${badgeClass}">\${badgeLabel}</div>
            <img src="\${safeCover}" class="mini-cover" loading="lazy" onerror="this.src='https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image'">
            <div class="mini-info">
              <div class="mini-title">\${d.title}</div>
              <div class="mini-khmer">\${d.titleKhmer || 'រឿងភាគខ្លីពិសេស'}</div>
              <div class="mini-heat">\${d.heat ? '🔥 ' + d.heat : 'Hongguo Official'}</div>
              <div class="mini-tags">
                \${(d.tags || []).slice(0, 2).map(t => \`<span class="mini-tag">\${t}</span>\`).join('')}
                <span class="mini-tag" style="background: rgba(56, 161, 105, 0.2); color: #9ae6b4;">\${totalEps} ភាគ</span>
              </div>
            </div>
          </div>
        \`;
      }).join('');
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

    // 10-Minute Countdown Timer
    setInterval(() => {
      refreshSecondsLeft--;
      if (refreshSecondsLeft <= 0) {
        reloadCurrentCategory(true);
        refreshSecondsLeft = 600;
      }
      const mins = Math.floor(refreshSecondsLeft / 60);
      const secs = refreshSecondsLeft % 60;
      const str = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
      const timerEl = document.getElementById('timerCountdown');
      if (timerEl) timerEl.innerText = str;
    }, 1000);

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

        html += \`
          <div id="pill_ep_\${ep}" class="ep-pill \${state}" onclick="handlePillClick(\${ep})">
            <span>EP\${String(ep).padStart(2, '0')}</span>
            <span class="ep-subtext">\${subText}</span>
          </div>
        \`;
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
      document.getElementById('epStats').innerText = \`បានទាញយក: \${done} ភាគ | នៅសល់: \${currentDrama.total - done} ភាគ\`;
    }

    async function loadDrama(id, title, cover, total, titleKhmer) {
      currentDrama = { seriesId: id, title, cover, total: total || 80, titleKhmer };
      document.getElementById('bannerTitle').innerText = title;
      document.getElementById('bannerKhmer').innerText = titleKhmer || title;
      document.getElementById('bannerCover').src = cover;
      document.getElementById('bannerId').innerText = 'Series ID: ' + id;
      document.getElementById('bannerTotal').innerText = 'សរុប: ' + (total || 80) + ' ភាគ';
      document.getElementById('btnDownloadAll').innerText = \`🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ \${total || 80})\`;

      // Auto-translate banner Khmer title with Gemini in background
      autoGeminiTranslateTitle(title);

      episodeStates = {};
      for (let i = 1; i <= currentDrama.total; i++) {
        episodeStates[i] = 'pending';
      }
      renderEpisodesGrid();

      // Check existing files on disk
      try {
        const res = await fetch('/api/scanned-episodes?seriesId=' + id);
        const data = await res.json();
        if (data && data.downloaded && data.downloaded.length > 0) {
          data.downloaded.forEach(ep => { episodeStates[ep] = 'done'; });
          renderEpisodesGrid();
        }
      } catch (_) {}
    }

    let activeEventSource = null;

    function connectSSE() {
      if (activeEventSource) {
        try { activeEventSource.close(); } catch (_) {}
      }
      activeEventSource = new EventSource('/api/progress');
      activeEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.status === 'cancelled') {
          if (activeEventSource) {
            try { activeEventSource.close(); } catch (_) {}
            activeEventSource = null;
          }
          isDownloading = false;
          document.getElementById('liveStatusText').innerText = '🛑 បានផ្អាកការទាញយកដោយជោគជ័យ';
          document.getElementById('btnDownloadAll').innerText = '🚀 បន្តទាញយកគ្រប់ភាគទាំងអស់';
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
            if (data.status === 'downloading') pill.children[1].innerText = (data.percent || 15) + '%';
            if (data.status === 'done') pill.children[1].innerText = '✓ រួចរាល់';
          }
          updateStats();
        }
        if (data.type === 'global' || data.message) {
          document.getElementById('liveStatusText').innerText = data.message || 'កំពុងដំណើរការ...';
          if (data.progress !== undefined) {
            document.getElementById('liveProgressBar').style.width = data.progress + '%';
            document.getElementById('livePercentText').innerText = data.progress + '%';
          }
        }
        if (data.status === 'done') {
          isDownloading = false;
          document.getElementById('btnDownloadAll').innerText = '🚀 ទាញយកគ្រប់ភាគទាំងអស់';
          document.getElementById('btnDownloadAll').disabled = false;
          if (activeEventSource) {
            try { activeEventSource.close(); } catch (_) {}
            activeEventSource = null;
          }
        }
      };
    }

    function downloadAllEpisodes() {
      const selectedEps = [];
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] !== 'done') selectedEps.push(ep);
      }
      if (selectedEps.length === 0) return alert('គ្រប់ភាគទាំងអស់ត្រូវបានទាញយករួចរាល់ហើយ!');

      triggerDownload(selectedEps);
    }

    function downloadSingleEpisode(ep) {
      triggerDownload([ep]);
    }

    function triggerDownload(eps) {
      isDownloading = true;
      document.getElementById('progressCard').style.display = 'block';
      document.getElementById('btnDownloadAll').innerText = '⏳ កំពុងដំណើរការទាញយក...';
      document.getElementById('btnDownloadAll').disabled = true;

      connectSSE();

      const autoMerge = document.getElementById('autoMergeCheck').checked;
      fetch('/api/start-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId: currentDrama.seriesId, selectedEps: eps, autoMerge, workers: 4 })
      });
    }

    async function stopDownload() {
      document.getElementById('liveStatusText').innerText = '⏳ កំពុងផ្អាក...';
      if (activeEventSource) {
        try { activeEventSource.close(); } catch (_) {}
        activeEventSource = null;
      }
      isDownloading = false;
      document.getElementById('btnDownloadAll').innerText = '🚀 បន្តទាញយកគ្រប់ភាគទាំងអស់';
      document.getElementById('btnDownloadAll').disabled = false;

      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] === 'downloading') {
          episodeStates[ep] = 'pending';
        }
      }
      renderEpisodesGrid();

      await fetch('/api/stop-download', { method: 'POST' });
      document.getElementById('liveStatusText').innerText = '🛑 បានផ្អាកការទាញយកដោយជោគជ័យ';
    }

    function openFolder() {
      fetch('/api/open-folder', { method: 'POST' });
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

    window.onload = () => {
      checkKeyStatus();
      loadCategoryDramas('trending');
      loadDrama(currentDrama.seriesId, currentDrama.title, currentDrama.cover, currentDrama.total, currentDrama.titleKhmer);
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
    let dramas = [];
    if (category === 'trending') {
      if (force || cachedTrendingDramas.length === 0) await refreshTrendingDramas();
      dramas = cachedTrendingDramas;
    } else {
      dramas = await fetchCategoryDramas(category, force);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      category,
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ downloaded }));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ downloaded: [] }));
    }
  }

  if (url.pathname === '/api/progress') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
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

  if (url.pathname === '/api/open-folder' && req.method === 'POST') {
    exec('explorer.exe "D:\\HDRG"');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
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
async function testGeminiKey(apiKey) {
  if (!apiKey) throw new Error('សូមបញ្ចូល API Key!');
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;
  for (const model of models) {
    try {
      return await callGeminiModel(model, apiKey, "Translate '你好' to Khmer in 1 word.");
    } catch (err) {
      lastError = err;
      if (!err.message.includes('not found') && !err.message.includes('not supported') && !err.message.includes('no longer available')) throw err;
    }
  }
  throw lastError;
}

async function callGemini(prompt) {
  const cfg = loadConfig();
  const apiKey = cfg.GEMINI_API_KEY;
  if (!apiKey) throw new Error('មិនទាន់ដាក់ Gemini API Key — ចុច 🔑 Gemini Key ក្នុង topbar');

  // Try available flash models in order
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const result = await callGeminiModel(model, apiKey, prompt);
      return result;
    } catch (err) {
      lastError = err;
      if (!err.message.includes('not found') && !err.message.includes('not supported') && !err.message.includes('no longer available')) throw err;
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
      }
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
    reqG.on('error', reject);
    reqG.write(bodyStr);
    reqG.end();
  });
}

server.listen(PORT, () => {
  console.log(`HDRG Pro Plus Downloader running at: http://localhost:${PORT}`);
});
