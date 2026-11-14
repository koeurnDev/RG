const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');

const axios = require('axios');
const cloudLicense = require('./lib/cloud-license');
const { fetchEpisodeList } = require('./hongguo-drama/src/native/hongguo');
const { searchHongguo } = require('./hongguo-drama/src/native/hongguo-search');
const { readRouterData, browseList } = require('./hongguo-drama/src/native/catalog');

const { fetchAppPlayUrl, requestJson: appRequestJson } = require('./hongguo-drama/src/native/app-source');
const { getPlaybackDevice } = require('./hongguo-drama/src/native/playback-device');

const dl = require('./lib/downloader');
const sources = require('./lib/sources');
const ytdlp = require('./lib/ytdlp');

const PORT = Number(process.env.HDRG_PORT || 3000);
const IS_PACKAGED_CLIENT = process.env.EZA_PACKAGED_CLIENT === '1';
const DEFAULT_DOWNLOAD_DIR =
  process.env.EZA_DEFAULT_DOWNLOAD_DIR ||
  (IS_PACKAGED_CLIENT ? path.join(os.homedir(), 'Videos', 'EZA PRO Downloader') : 'D:\\HDRG');
const PUBLIC_HTML = path.join(__dirname, 'public', 'index.html');
const CONFIG_FILE =
  process.env.HDRG_CONFIG_FILE ||
  (process.env.EZA_USER_DATA_DIR ? path.join(process.env.EZA_USER_DATA_DIR, 'config.json') : path.join(__dirname, 'config.json'));
const ENV_FILE = path.join(__dirname, 'hongguo-drama', 'scripts', '.env');
const ISOLATED_CONFIG_ONLY = process.env.HDRG_ISOLATED === '1' || IS_PACKAGED_CLIENT;

let progressClients = [];
const jobsMap = new Map(); // jobId -> job
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'retrying', 'merging']);
const MAX_JOB_HISTORY = 30;
const GLOBAL_DOWNLOAD_SEM = dl.createSemaphore(24);
const GLOBAL_BYTEVC2_SEM = dl.createSemaphore((os.cpus().length || 4) >= 6 ? 2 : 1);
const dramaCache = new Map(); // sid -> { timestamp, data }
const DRAMA_CACHE_TTL_MS = 5 * 60 * 1000;

// ===== Configuration & Gemini Key Storage =====
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
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch (_) {}
  return result;
}

function saveEnvFile(filePath, updates) {
  try {
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const newLine = `${key}="${val}"`;
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = content.trim() ? `${content.trim()}\n${newLine}\n` : `${newLine}\n`;
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error('[ENV] Cannot save .env:', err.message);
  }
}

let customFolderPickerHandler = null;
function setFolderPickerHandler(handler) {
  customFolderPickerHandler = typeof handler === 'function' ? handler : null;
}

function loadConfig() {
  const envData = ISOLATED_CONFIG_ONLY ? {} : parseEnvFile(ENV_FILE);
  const cfg = {
    GEMINI_API_KEY: envData.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
    DOWNLOAD_DIR: envData.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed.GEMINI_API_KEY) cfg.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
      if (parsed.DOWNLOAD_DIR) cfg.DOWNLOAD_DIR = parsed.DOWNLOAD_DIR;
    }
  } catch (_) {}
  return cfg;
}

function getDownloadDir() {
  const cfg = loadConfig();
  const dir = cfg.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function saveConfig(cfg) {
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  if (!ISOLATED_CONFIG_ONLY) {
    saveEnvFile(ENV_FILE, {
      GEMINI_API_KEY: merged.GEMINI_API_KEY || '',
      DOWNLOAD_DIR: merged.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
    });
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  if (!ISOLATED_CONFIG_ONLY) {
    try {
      const ezargDir = 'D:\\EZARG';
      if (fs.existsSync(ezargDir)) {
        fs.writeFileSync(path.join(ezargDir, 'config.json'), JSON.stringify(merged, null, 2), 'utf8');
      }
    } catch (_) {}
  }
}

async function promptFolderPicker(initialPath = DEFAULT_DOWNLOAD_DIR) {
  if (customFolderPickerHandler) {
    return await customFolderPickerHandler(initialPath || DEFAULT_DOWNLOAD_DIR);
  }
  return await new Promise((resolve) => {
    const safePath = String(initialPath || DEFAULT_DOWNLOAD_DIR).replace(/'/g, "''");
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $f = New-Object System.Windows.Forms.FolderBrowserDialog
      $f.Description = 'EZA PRO Downloader: Select Download Folder'
      if (Test-Path -LiteralPath '${safePath}') {
        $f.SelectedPath = '${safePath}'
      }
      $f.ShowNewFolderButton = $true
      $top = New-Object System.Windows.Forms.Form
      $top.TopMost = $true
      $top.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
      $top.Size = New-Object System.Drawing.Size(1, 1)
      $top.Show()
      $top.Activate()
      $res = $f.ShowDialog($top)
      $top.Close()
      $top.Dispose()
      if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Write-Output $f.SelectedPath
      }
    `;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', b64]);
    let stdout = '';
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve(null);
    }, 90000);
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.on('close', () => { clearTimeout(timeout); resolve(stdout.trim() || null); });
    child.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// ===== Drama Catalog & Khmer Quick Dictionary =====
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
  { id: 'suspense', name: '🔍 អាថ៌កំបាំង', badge: 'MYSTERY', icon: '🔍' },
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
  ['开局', 'ចាប់ផ្ដើមរឿង'],
];

function getKhmerTitle(title) {
  if (!title) return '';
  let kh = title;
  for (const [cn, km] of KHMER_DICT) {
    if (kh.includes(cn)) kh = kh.split(cn).join(km + ' ');
  }
  return kh === title ? '' : kh.trim();
}

let cachedTrendingDramas = [];
let nextRefreshTimestamp = Date.now() + 10 * 60 * 1000;
const categoryCache = new Map();

async function refreshTrendingDramas() {
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
          timeout: 6000,
        });
        const router = readRouterData(res.data);
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
                tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : ['热门', '短剧'],
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
    console.log(`[Trending] ទទួលបានរឿងភាគល្បីៗចំនួន ${cachedTrendingDramas.length} រឿង!`);
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
    if (!force && categoryCache.has(cacheKey)) return categoryCache.get(cacheKey).dramas;
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
            rank: 100 + (pg - 2) * 24 + extraList.length,
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

  const list = [];
  const seen = new Set();
  function addItem(item, defaultTag) {
    if (!item) return;
    const id = String(item.series_id || item.seriesId || '').trim();
    const title = String(item.series_title || item.title || '').trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      title,
      titleKhmer: getKhmerTitle(title),
      cover: item.cover || item.series_cover || '',
      heat: item.heat || item.heatText || '',
      total: Number(item.episode_count || item.episodeCount) || 80,
      tags: Array.isArray(item.tags) && item.tags.length ? item.tags.slice(0, 3) : [defaultTag],
      category,
    });
  }

  try {
    if (category === 'sad') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('虐恋', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('苦情', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('追妻', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '虐恋'));
      r2.results?.forEach(i => addItem(i, '苦情'));
      r3.results?.forEach(i => addItem(i, '追妻'));
    } else if (category === 'sweet') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('甜宠', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('先婚后爱', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('暗恋成真', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '甜宠'));
      r2.results?.forEach(i => addItem(i, '先婚后爱'));
      r3.results?.forEach(i => addItem(i, '暗恋成真'));
    } else if (category === 'romance') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'romance', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('爱情', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '爱情'));
      r2.results?.forEach(i => addItem(i, '都市爱情'));
    } else if (category === 'ceo') {
      const [r1, r2, r3] = await Promise.all([
        searchHongguo('总裁', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('豪门', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('闪婚', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '总裁'));
      r2.results?.forEach(i => addItem(i, '豪门'));
      r3.results?.forEach(i => addItem(i, '闪婚'));
    } else if (category === 'comeback') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comeback', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('逆袭', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '逆袭'));
      r2.results?.forEach(i => addItem(i, '战神'));
    } else if (category === 'costume') {
      const [r1, r2, r3] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'costume', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('古装', { page: pg }).catch(() => ({ results: [] })),
        searchHongguo('穿越', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '古装'));
      r2.results?.forEach(i => addItem(i, '穿越'));
      r3.results?.forEach(i => addItem(i, '重生'));
    } else if (category === 'comedy') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'comedy', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('喜剧', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '喜剧'));
      r2.results?.forEach(i => addItem(i, '搞笑'));
    } else if (category === 'family') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'family', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('家庭', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '家庭'));
      r2.results?.forEach(i => addItem(i, '婚姻'));
    } else if (category === 'suspense') {
      const [r1, r2] = await Promise.all([
        browseList({ category: 'real-drama', genre: 'suspense', page: pg }).catch(() => ({ results: [] })),
        searchHongguo('悬疑', { page: pg }).catch(() => ({ results: [] })),
      ]);
      r1.results?.forEach(i => addItem(i, '悬疑'));
      r2.results?.forEach(i => addItem(i, '惊悚'));
    }
  } catch (err) {
    console.error(`[Category ${category} p${pg}] Error:`, err.message);
  }

  categoryCache.set(cacheKey, { timestamp: Date.now(), dramas: list });
  return list;
}

let catalogWarmupStarted = false;
let catalogWarmupTimers = [];
let trendingRefreshTimer = null;

function startCatalogWarmup() {
  if (catalogWarmupStarted) return;
  catalogWarmupStarted = true;
  refreshTrendingDramas().then(() => {
    const delays = [
      ['sad', 500],
      ['sweet', 1500],
      ['ceo', 2500],
      ['romance', 3500],
      ['comeback', 4500]
    ];
    for (const [cat, ms] of delays) {
      const t = setTimeout(() => fetchCategoryDramas(cat), ms);
      if (t.unref) t.unref();
      catalogWarmupTimers.push(t);
    }
  }).catch(() => {});

  trendingRefreshTimer = setInterval(() => {
    refreshTrendingDramas();
    categoryCache.clear();
  }, 10 * 60 * 1000);
  if (trendingRefreshTimer.unref) trendingRefreshTimer.unref();
}

function stopCatalogWarmup() {
  for (const t of catalogWarmupTimers) {
    try { clearTimeout(t); } catch (_) {}
  }
  catalogWarmupTimers = [];
  if (trendingRefreshTimer) {
    try { clearInterval(trendingRefreshTimer); } catch (_) {}
    trendingRefreshTimer = null;
  }
  catalogWarmupStarted = false;
}

// ===== Drama Metadata Lookup & Episode List Resolver =====
function buildKnownMetaByFolder() {
  const map = new Map();
  const addEntry = (id, title, titleKhmer, cover, total) => {
    if (!title) return;
    const folder = dl.sanitizeTitle(title, id);
    if (!folder) return;
    const prev = map.get(folder) || {};
    map.set(folder, {
      seriesId: String(id || prev.seriesId || ''),
      title: String(title || prev.title || ''),
      titleKhmer: String(titleKhmer || prev.titleKhmer || getKhmerTitle(title) || ''),
      cover: String(cover || prev.cover || ''),
      total: Number(total || prev.total || 0),
    });
  };
  for (const d of cachedTrendingDramas) {
    addEntry(d.id, d.title, d.titleKhmer, d.cover, d.total);
  }
  for (const entry of categoryCache.values()) {
    for (const d of (entry.dramas || [])) addEntry(d.id, d.title, d.titleKhmer, d.cover, d.total);
  }
  for (const [sid, cached] of dramaCache.entries()) {
    const info = cached?.data;
    if (info) addEntry(info.series_id || sid, info.series_title, getKhmerTitle(info.series_title), info.cover, info.episodes?.length);
  }
  return map;
}

function findDramaMetaBySeriesId(seriesId) {
  const sid = String(seriesId || '').trim();
  if (!sid) return {};
  const cached = dramaCache.get(sid)?.data;
  if (cached) {
    return {
      title: cached.series_title || '',
      titleKhmer: getKhmerTitle(cached.series_title),
      cover: cached.cover || '',
      total: cached.episodes?.length || 0,
    };
  }
  for (const d of cachedTrendingDramas) {
    if (String(d.id) === sid) return d;
  }
  for (const entry of categoryCache.values()) {
    const found = (entry.dramas || []).find((d) => String(d.id) === sid);
    if (found) return found;
  }
  return {};
}

async function fetchEpisodeListSafe(seriesId, force = false) {
  const sid = String(seriesId || '').trim();
  if (!sid) throw new Error('Series ID មិនត្រឹមត្រូវ');
  const cached = dramaCache.get(sid);
  if (!force && cached && Date.now() - cached.timestamp < DRAMA_CACHE_TTL_MS) {
    return cached.data;
  }
  const source = sources.detectSourceFromId(sid);
  const fetcher = () => (source === 'hongguo'
    ? fetchEpisodeList(sid, { force })
    : sources.fetchEpisodeListUnified(sid, { force }));
  let res = null;
  try {
    res = await fetcher();
  } catch (err) {
    await dl.sleep(600);
    res = await fetcher();
  }
  if (res && !res.source) res.source = source;
  dramaCache.set(sid, { timestamp: Date.now(), data: res });
  if (res?.series_title) {
    const cleanTitle = dl.sanitizeTitle(res.series_title, sid);
    const outputDir = path.join(getDownloadDir(), cleanTitle);
    if (fs.existsSync(outputDir)) {
      dl.saveDramaMeta(outputDir, {
        seriesId: String(res.series_id || sid),
        title: res.series_title,
        titleKhmer: getKhmerTitle(res.series_title),
        cover: res.cover || '',
        source: res.source || source,
        total: Array.isArray(res.episodes) ? res.episodes.length : 0,
      });
    }
  }
  return res;
}

function extractSeriesId(input) {
  if (!input) return null;
  const str = String(input).trim();
  const multiId = sources.resolveDramaUrlOrId(str);
  if (multiId) return multiId;
  const queryMatch = str.match(/(?:video_)?series_id=(\d+)/);
  if (queryMatch) return queryMatch[1];
  const pathMatch = str.match(/\/(?:player|detail)\/(\d{10,30})\b/);
  if (pathMatch) return pathMatch[1];
  const digitsMatch = str.match(/^\d{10,30}$/);
  if (digitsMatch) return digitsMatch[0];
  return null;
}

async function smartResolve(input, preferredSource = 'hongguo', cookiesFromBrowser = '') {
  const str = String(input || '').trim();
  if (ytdlp.isSocialVideoUrl(str)) {
    const socialInfo = await ytdlp.probeUrl(str, { cookiesFromBrowser });
    return { isSocial: true, socialInfo };
  }

  const seriesId = extractSeriesId(str);
  if (seriesId) {
    const info = await fetchEpisodeListSafe(seriesId);
    return {
      seriesId: String(info.series_id || seriesId),
      source: info.source || sources.detectSourceFromId(seriesId),
      title: info.series_title,
      titleKhmer: getKhmerTitle(info.series_title),
      cover: info.cover,
      total: info.episodes.length,
      episodes: info.episodes,
      matches: [],
    };
  }

  if (preferredSource && !['hongguo', 'social'].includes(preferredSource)) {
    const srcMatches = await sources.searchSource(preferredSource, str, 1, getKhmerTitle);
    if (srcMatches.length > 0) {
      const top = srcMatches[0];
      if (srcMatches.length === 1) {
        const info = await fetchEpisodeListSafe(top.id);
        return {
          seriesId: String(info.series_id || top.id),
          source: preferredSource,
          title: info.series_title || top.title,
          titleKhmer: getKhmerTitle(info.series_title || top.title),
          cover: info.cover || top.cover,
          total: info.episodes.length || top.total,
          episodes: info.episodes,
          matches: [],
        };
      }
      return {
        seriesId: String(top.id),
        source: preferredSource,
        title: top.title,
        titleKhmer: top.titleKhmer,
        cover: top.cover,
        total: top.total,
        matches: srcMatches.slice(0, 18),
      };
    }
    throw new Error(`រកមិនឃើញរឿង "${str}" នៅលើ ${preferredSource} ទេ — សូមសាកល្បងពាក្យផ្សេង ឬបិទភ្ជាប់ Link!`);
  }

  const searchRes = await searchHongguo(str);
  if (searchRes && Array.isArray(searchRes.results) && searchRes.results.length > 0) {
    const matches = searchRes.results.slice(0, 12).map((item, idx) => ({
      id: String(item.series_id),
      title: item.series_title,
      titleKhmer: getKhmerTitle(item.series_title),
      cover: item.cover || '',
      heat: item.episode_count ? `${item.episode_count} ភាគ` : 'Hongguo',
      total: Number(item.episode_count) || 80,
      tags: item.tags || ['ស្វែងរក'],
      source: 'hongguo',
      rank: idx + 1,
    }));
    const top = searchRes.results[0];
    const info = await fetchEpisodeListSafe(top.series_id);
    return {
      seriesId: String(top.series_id),
      source: 'hongguo',
      title: info.series_title || top.series_title,
      titleKhmer: getKhmerTitle(info.series_title || top.series_title),
      cover: info.cover || top.cover,
      total: info.episodes.length || top.episode_count,
      episodes: info.episodes,
      matches,
    };
  }

  throw new Error(`រកមិនឃើញរឿងសម្រាប់ "${str}" ទេ — សូមសាកល្បងឈ្មោះចិន ឬបិទភ្ជាប់ Link / Series ID!`);
}

// ===== Real-Time Broadcast & Multi-Job Snapshot State =====
function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of progressClients) {
    try { client.res.write(message); } catch (_) {}
  }
}

function getJobSnapshot(job) {
  if (!job) return { active: false, status: 'idle' };
  const activeDownloading = Object.values(job.episodeStates).filter(s => ['resolving', 'downloading'].includes(s.status)).length;
  const activeTranscoding = Object.values(job.episodeStates).filter(s => ['queued_transcode', 'transcoding', 'decrypting'].includes(s.status)).length;
  return {
    active: ACTIVE_JOB_STATUSES.has(job.status),
    mode: job.mode || 'download',
    jobId: job.id,
    status: job.status,
    seriesId: job.seriesId,
    title: job.title,
    titleKhmer: job.titleKhmer || '',
    cover: job.cover || '',
    folder: job.folder || (job.outputDir ? path.basename(job.outputDir) : ''),
    outputDir: job.outputDir,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    activeDownloading,
    activeTranscoding,
    workers: job.workers,
    qualityMode: job.qualityMode,
    downloadedMb: (job.downloadedBytes / (1024 * 1024)).toFixed(1),
    speedMb: Number(job.speedMb || 0),
    speedText: job.speedText || '0.0 MB/s',
    etaSec: job.etaSec,
    elapsedSec: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000),
    createdAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    progress: job.progress,
    message: job.message,
    logs: job.logs.slice(-20),
    episodes: job.episodeStates,
    failedList: job.failedList || [],
  };
}

function getAllJobSnapshots() {
  const all = [...jobsMap.values()];
  all.sort((a, b) => {
    const aAct = ACTIVE_JOB_STATUSES.has(a.status) ? 1 : 0;
    const bAct = ACTIVE_JOB_STATUSES.has(b.status) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return (b.finishedAt || b.startedAt) - (a.finishedAt || a.startedAt);
  });
  return all.map((j) => getJobSnapshot(j));
}

function getJobsSummary() {
  let activeCount = 0;
  let totalCompleted = 0;
  let totalQueued = 0;
  let combinedSpeedMb = 0;
  for (const j of jobsMap.values()) {
    if (ACTIVE_JOB_STATUSES.has(j.status)) {
      activeCount++;
      totalCompleted += j.completed || 0;
      totalQueued += j.total || 0;
      combinedSpeedMb += Number(j.speedMb || 0);
    }
  }
  return {
    activeCount,
    totalJobs: jobsMap.size,
    totalCompleted,
    totalQueued,
    totalSpeedText: `${combinedSpeedMb.toFixed(1)} MB/s`,
  };
}

function getPrimaryJobSnapshot() {
  const all = getAllJobSnapshots();
  return all.length ? all[0] : { active: false, status: 'idle' };
}

function trimFinishedJobs() {
  if (jobsMap.size <= MAX_JOB_HISTORY) return;
  const finished = [...jobsMap.values()]
    .filter((j) => !ACTIVE_JOB_STATUSES.has(j.status))
    .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt));
  while (jobsMap.size > MAX_JOB_HISTORY && finished.length > 0) {
    const oldest = finished.shift();
    jobsMap.delete(oldest.id);
  }
}

function findActiveJob(seriesId, folder = '') {
  const sid = String(seriesId || '').trim();
  const fld = String(folder || '').trim();
  for (const job of jobsMap.values()) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    if (sid && String(job.seriesId) === sid) return job;
    const jobFolder = job.folder || (job.outputDir ? path.basename(job.outputDir) : '');
    if (fld && jobFolder && jobFolder === fld) return job;
  }
  return null;
}

function pushJobLog(job, text) {
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const entry = `[${ts}] ${text}`;
  job.logs.push(entry);
  if (job.logs.length > 40) job.logs.shift();
  console.log(`[Job ${job.seriesId || job.folder}] ${entry}`);
}

function emitSnapshot(job, force = false) {
  const now = Date.now();
  if (!force && job && job.lastBroadcastAt && now - job.lastBroadcastAt < 250) return;
  if (job) job.lastBroadcastAt = now;
  broadcastSSE({
    type: 'snapshot',
    snapshot: job ? getJobSnapshot(job) : getPrimaryJobSnapshot(),
    jobs: getAllJobSnapshots(),
    summary: getJobsSummary(),
  });
}

function cancelJob(job, reasonMsg = '🛑 បានបញ្ឈប់ការទាញយក!') {
  if (!job) return;
  job.cancelled = true;
  job.status = 'cancelled';
  job.message = reasonMsg;
  job.speedMb = 0;
  job.speedText = '0.0 MB/s';
  job.finishedAt = Date.now();
  try { job.abortController.abort(new Error('CANCELLED')); } catch (_) {}
  for (const child of job.activeChildren) {
    ytdlp.killProcessTree(child);
  }
  job.activeChildren.clear();
  for (const epKey of Object.keys(job.episodeStates)) {
    const st = job.episodeStates[epKey].status;
    if (!['done', 'error'].includes(st)) {
      job.episodeStates[epKey] = { status: 'pending', percent: 0, text: 'បានផ្អាក' };
    }
  }
  pushJobLog(job, reasonMsg);
  emitSnapshot(job, true);
}

function cancelAllActiveJobs(reasonMsg = '🛑 បានបញ្ឈប់ការទាញយកទាំងអស់!') {
  for (const job of jobsMap.values()) {
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      cancelJob(job, reasonMsg);
    }
  }
}

// ===== Turbo Batch Download Engine with Auto-Retry & ByteVC2 Support =====
async function runBatchDownload(job) {
  const { seriesId, selectedEps, autoMerge, workers = 8, qualityMode = '1080p' } = job;
  const signal = job.abortController.signal;

  // Rolling 2.5s byte window for accurate live MB/s measurement
  const byteWindow = [];
  function recordBytes(delta) {
    if (!delta || delta <= 0) return;
    job.downloadedBytes += delta;
    const now = Date.now();
    byteWindow.push({ t: now, b: delta });
    while (byteWindow.length && now - byteWindow[0].t > 2500) {
      byteWindow.shift();
    }
    const windowBytes = byteWindow.reduce((sum, x) => sum + x.b, 0);
    const spanSec = byteWindow.length > 1 ? Math.max(0.5, (now - byteWindow[0].t) / 1000) : 1;
    const mbPerSec = (windowBytes / (1024 * 1024)) / spanSec;
    job.speedMb = mbPerSec;
    job.speedText = `${mbPerSec.toFixed(1)} MB/s`;
  }

  try {
    job.status = 'running';
    job.message = '📡 កំពុងទាញយកបញ្ជីភាគ និងត្រួតពិនិត្យ Folder...';
    const sourceTag = sources.detectSourceFromId(seriesId);
    pushJobLog(job, `📡 កំពុងទាញយកព័ត៌មានបញ្ជីភាគពី ${sourceTag.toUpperCase()}...`);
    emitSnapshot(job, true);

    const info = await fetchEpisodeListSafe(seriesId);
    if (job.cancelled || signal.aborted) return;

    const cleanTitle = dl.sanitizeTitle(info.series_title, seriesId);
    job.title = info.series_title;
    job.titleKhmer = job.titleKhmer || getKhmerTitle(info.series_title);
    job.cover = job.cover || info.cover || '';
    job.folder = cleanTitle;
    const outputDir = path.join(getDownloadDir(), cleanTitle);
    job.outputDir = outputDir;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const totalDramaEps = info.episodes.length;
    dl.saveDramaMeta(outputDir, {
      seriesId,
      title: info.series_title,
      titleKhmer: job.titleKhmer,
      cover: job.cover,
      source: info.source || sourceTag,
      total: totalDramaEps,
    });

    // Clean orphaned temp files and 0-byte corrupted MP4s before starting
    const cleaned = dl.removeBrokenMp4Files(outputDir);
    if (cleaned > 0) {
      pushJobLog(job, `🧹 បានសម្អាតឯកសារខូច/0MB ចាស់ៗចំនួន ${cleaned} ឯកសារដើម្បីទាញឡើងវិញ!`);
    }

    dl.organizeDramaFolder(outputDir, cleanTitle, totalDramaEps);
    const lockedSet = new Set(info.episodes.filter((e) => e.locked).map((e) => Number(e.vid_index)));
    const rawTargets = (!selectedEps || selectedEps === 'all')
      ? info.episodes.filter((e) => !e.locked).map((e) => Number(e.vid_index))
      : selectedEps;
    const targetNums = [...new Set((rawTargets || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= totalDramaEps))];
    targetNums.sort((a, b) => a - b);

    if ((!selectedEps || selectedEps === 'all') && lockedSet.size > 0 && targetNums.length > 0) {
      pushJobLog(job, `🔒 រឿងនេះមាន ${lockedSet.size} ភាគជាប់សោ VIP — ទាញយកភាគឥតគិតថ្លៃ ${targetNums.length} ភាគ!`);
    }

    if (targetNums.length === 0) {
      throw new Error(lockedSet.size > 0 ? 'គ្រប់ភាគទាំងអស់ជាប់សោ VIP លើវេទិកាដើម!' : 'គ្មានភាគត្រឹមត្រូវសម្រាប់ទាញយកទេ');
    }

    job.total = targetNums.length;
    for (const num of targetNums) {
      job.episodeStates[num] = { status: 'queued', percent: 0, text: 'រង់ចាំ...' };
    }

    const activeConcurrency = Math.min(Math.max(1, Number(workers) || 8), targetNums.length);
    job.workers = activeConcurrency;
    const bytevc2Sem = GLOBAL_BYTEVC2_SEM;

    job.progress = 5;
    job.message = `🚀 ចាប់ផ្ដើមទាញយក ${targetNums.length} ភាគ (${activeConcurrency} Threads • ${qualityMode === 'fast' ? '⚡ Fast Hybrid' : '💎 1080p HD'})`;
    pushJobLog(job, job.message);
    emitSnapshot(job, true);

    const completedMap = new Map(); // epNum -> finalMp4
    const failedMap = new Map(); // epNum -> errorMsg
    const playUrlMap = new Map();
    const inflightResolve = new Map();

    // Helper: fetch play info once per episode (avoid duplicate parallel calls for same ep)
    async function getPlayInfoCached(epNum, epData) {
      if (playUrlMap.has(epNum)) return playUrlMap.get(epNum);
      if (inflightResolve.has(epNum)) return inflightResolve.get(epNum);
      const p = (async () => {
        const res = await dl.resolvePlayInfoSmart(epData, seriesId, {
          qualityMode,
          signal,
          onLog: (msg) => { pushJobLog(job, msg); emitSnapshot(job, false); },
        });
        playUrlMap.set(epNum, res);
        return res;
      })().finally(() => inflightResolve.delete(epNum));
      inflightResolve.set(epNum, p);
      return p;
    }

    // Rolling prefetcher (batch 12/call for HongGuo, 6 concurrent resolvers for DramaBox/ReelShort/Hema/Xifan)
    const PREFETCH_BATCH_HONGGUO = 12;
    const PREFETCH_BATCH_OTHER = 6;
    let prefetchCursor = 0;
    let activeQueueCursor = 0;

    async function prefetchNextBatch(epList) {
      const batchSize = sourceTag === 'hongguo' ? PREFETCH_BATCH_HONGGUO : PREFETCH_BATCH_OTHER;
      const batchItems = [];
      while (prefetchCursor < epList.length && batchItems.length < batchSize) {
        const item = epList[prefetchCursor++];
        if (!item || item.epData?.locked || playUrlMap.has(item.epNum) || completedMap.has(item.epNum)) continue;
        const existing = dl.findExistingEpisodeFile(outputDir, cleanTitle, item.epNum, totalDramaEps);
        if (existing && dl.isValidMp4File(existing)) continue;
        batchItems.push(item);
      }
      if (!batchItems.length) return false;
      if (sourceTag === 'hongguo') {
        const resolvedMap = await dl.resolveBatchPlayInfos(batchItems, { qualityMode, signal });
        for (const [epNum, resolvedInfo] of resolvedMap.entries()) {
          playUrlMap.set(epNum, resolvedInfo);
        }
      } else {
        await Promise.allSettled(
          batchItems.map((item) => getPlayInfoCached(item.epNum, item.epData).catch(() => null))
        );
      }
      return true;
    }

    const startPrefetchLoop = (epList) => (async () => {
      while (prefetchCursor < epList.length) {
        if (job.cancelled || signal.aborted) return;
        if (prefetchCursor - activeQueueCursor > 18) {
          await dl.sleep(200, signal);
          continue;
        }
        const ok = await prefetchNextBatch(epList);
        if (!ok && prefetchCursor < epList.length) {
          await dl.sleep(100, signal);
        }
      }
    })();

    function updateOverallProgress() {
      const done = completedMap.size;
      const fail = failedMap.size;
      job.completed = done;
      job.failed = fail;
      const elapsedSec = Math.max(1, (Date.now() - job.startedAt) / 1000);
      const finishedCount = done + fail;
      const left = Math.max(0, job.total - finishedCount);
      job.etaSec = finishedCount > 0 ? Math.round(left * (elapsedSec / finishedCount)) : Math.round(left * 2.5);
      const maxBar = autoMerge ? 88 : 99;
      job.progress = job.total > 0 ? Math.min(maxBar, Math.round(5 + (finishedCount / job.total) * (maxBar - 5))) : 5;
    }

    async function processOneEpisode(item, isRetryPass = false) {
      if (job.cancelled || signal.aborted) return;
      const { epNum, epData } = item;
      const finalFileName = dl.resolveEpisodeFileName(cleanTitle, epNum, totalDramaEps);
      const finalMp4 = path.join(outputDir, finalFileName);

      // Check existing valid file (handles resume cleanly)
      const existingFile = dl.findExistingEpisodeFile(outputDir, cleanTitle, epNum, totalDramaEps);
      if (existingFile && dl.isValidMp4File(existingFile)) {
        completedMap.set(epNum, existingFile);
        failedMap.delete(epNum);
        const mb = (fs.statSync(existingFile).size / (1024 * 1024)).toFixed(1);
        job.episodeStates[epNum] = { status: 'done', percent: 100, size: `${mb} MB`, text: `✓ ${mb} MB` };
        updateOverallProgress();
        emitSnapshot(job, false);
        return;
      }

      const tempEnc = path.join(outputDir, `temp_ep_${epNum}_${Date.now()}.enc`);
      const tempOut = path.join(outputDir, `temp_out_${epNum}_${Date.now()}.mp4`);

      try {
        job.episodeStates[epNum] = { status: 'resolving', percent: 8, text: '🔍 រក Link...' };
        emitSnapshot(job, false);

        const play = await getPlayInfoCached(epNum, epData);
        if (job.cancelled || signal.aborted) return;

        const variants = dl.extractVariants(play, qualityMode);
        if (!variants.length) throw new Error('គ្មាន Link ទាញយកវីដេអូសម្រាប់ភាគនេះ');

        let downloadedVariant = null;
        let lastDlError = null;

        await GLOBAL_DOWNLOAD_SEM(async () => {
          for (let vi = 0; vi < variants.length; vi++) {
            if (job.cancelled || signal.aborted) return;
            const variant = variants[vi];
            const isHls = variant.format === 'hls' || /\.m3u8(\?|$)/i.test(variant.url);
            const label = isHls ? 'HLS Stream' : (variant.codec === 'bytevc2' ? `ByteVC2 ${variant.quality}` : `${variant.codec || 'MP4'} ${variant.quality}`.trim());
            job.episodeStates[epNum] = { status: 'downloading', percent: 12, text: `⬇️ ទាញយក (${label})` };
            job.message = `⬇️ កំពុងទាញយកភាគ ${epNum}/${totalDramaEps} (${completedMap.size}/${job.total} រួចរាល់)...`;
            emitSnapshot(job, false);

            if (isHls) {
              try {
                await dl.downloadHlsToMp4(variant, tempOut, {
                  signal,
                  activeChildren: job.activeChildren,
                  onBytesProgress: (delta, dlPct) => {
                    recordBytes(delta);
                    job.episodeStates[epNum] = { status: 'downloading', percent: Math.min(92, dlPct), text: `⬇️ HLS ${dlPct}%` };
                    updateOverallProgress();
                    emitSnapshot(job, false);
                  },
                });
                downloadedVariant = { ...variant, format: 'hls' };
                break;
              } catch (hlsErr) {
                if (job.cancelled || signal.aborted || hlsErr.message === 'CANCELLED') return;
                lastDlError = hlsErr;
                try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (_) {}
                continue;
              }
            }

            if (dl.isAria2Available()) {
              try {
                await dl.downloadWithAria2(variant, tempEnc, {
                  signal,
                  activeChildren: job.activeChildren,
                  onBytesProgress: (delta, dlPct) => {
                    recordBytes(delta);
                    const scaledPct = Math.min(54, 12 + Math.round(dlPct * 0.42));
                    job.episodeStates[epNum] = { status: 'downloading', percent: scaledPct, text: `⚡ 16x ${dlPct}%` };
                    updateOverallProgress();
                    emitSnapshot(job, false);
                  },
                });
                downloadedVariant = variant;
                break;
              } catch (ariaErr) {
                if (job.cancelled || signal.aborted || ariaErr.message === 'CANCELLED') return;
                lastDlError = ariaErr;
                try { if (fs.existsSync(tempEnc)) fs.unlinkSync(tempEnc); } catch (_) {}
              }
            }

            try {
              await dl.downloadUrlStream(variant, tempEnc, {
                signal,
                onBytesProgress: (delta, dlPct) => {
                  recordBytes(delta);
                  const scaledPct = Math.min(54, 12 + Math.round(dlPct * 0.42));
                  job.episodeStates[epNum] = { status: 'downloading', percent: scaledPct, text: `⬇️ ${dlPct}%` };
                  updateOverallProgress();
                  emitSnapshot(job, false);
                },
              });
              downloadedVariant = variant;
              break;
            } catch (streamErr) {
              if (job.cancelled || signal.aborted || streamErr.message === 'CANCELLED') return;
              lastDlError = streamErr;
              try { if (fs.existsSync(tempEnc)) fs.unlinkSync(tempEnc); } catch (_) {}
              // On last variant or HTTP failure, try curl.exe fallback once for that variant
              if (vi === variants.length - 1) {
                try {
                  const bytes = await dl.downloadWithCurl(variant, tempEnc, { signal, activeChildren: job.activeChildren });
                  recordBytes(bytes);
                  downloadedVariant = variant;
                  break;
                } catch (curlErr) {
                  if (job.cancelled || signal.aborted || curlErr.message === 'CANCELLED') return;
                  lastDlError = curlErr;
                }
              }
            }
          }
        }, signal);

        if (!downloadedVariant) {
          throw lastDlError || new Error('បរាជ័យក្នុងការទាញយកពី CDN');
        }

        const isBytevc2 = downloadedVariant.codec === 'bytevc2';
        if (downloadedVariant.format !== 'hls') {
          if (!fs.existsSync(tempEnc)) {
            throw lastDlError || new Error('បរាជ័យក្នុងការទាញយកពី CDN');
          }
          // Decrypt or transcode into verified tempOut
          if (isBytevc2) {
            pushJobLog(job, `⚙️ ភាគ ${epNum}: កំពុងបំប្លែង ByteVC2 (${downloadedVariant.quality || 'HD'}) -> H.264...`);
          }

          await dl.processDownloadedEpisode(downloadedVariant, tempEnc, tempOut, {
            signal,
            activeChildren: job.activeChildren,
            bytevc2Sem,
            onPhaseProgress: (phase, pct) => {
              const labelMap = {
                queued_transcode: '⏳ រង់ចាំបំប្លែង...',
                transcoding: `⚙️ បំប្លែង ${pct}%`,
                decrypting: '🔓 ដោះសោ...',
                verifying: '🔍 ផ្ទៀងផ្ទាត់...',
              };
              job.episodeStates[epNum] = { status: phase, percent: pct, text: labelMap[phase] || '⚙️ បំប្លែង...' };
              job.message = isBytevc2
                ? `⚙️ កំពុងបំប្លែងភាគ ${epNum} (ByteVC2 -> MP4: ${pct}%) | រួចរាល់ ${completedMap.size}/${job.total}`
                : job.message;
              emitSnapshot(job, false);
            },
          });
        }

        if (job.cancelled || signal.aborted) return;

        // Strictly verify file before publishing!
        if (!dl.isValidMp4File(tempOut)) {
          throw new Error('ឯកសារក្រោយបំប្លែងមិនត្រឹមត្រូវ ឬ 0 Bytes');
        }

        if (fs.existsSync(finalMp4)) {
          try { fs.unlinkSync(finalMp4); } catch (_) {}
        }
        await fsp.rename(tempOut, finalMp4);

        const finalBytes = fs.statSync(finalMp4).size;
        const mb = (finalBytes / (1024 * 1024)).toFixed(1);
        completedMap.set(epNum, finalMp4);
        failedMap.delete(epNum);
        job.episodeStates[epNum] = { status: 'done', percent: 100, size: `${mb} MB`, text: `✓ ${mb} MB` };
        pushJobLog(job, `✅ ភាគ ${epNum}: រួចរាល់ (${mb} MB${isBytevc2 ? ' • H.264' : ''})`);
        updateOverallProgress();
        emitSnapshot(job, true);
      } catch (err) {
        if (job.cancelled || signal.aborted || err.message === 'CANCELLED') return;
        const errMsg = String(err.message || 'Unknown error').slice(0, 120);
        failedMap.set(epNum, errMsg);
        job.episodeStates[epNum] = { status: 'error', percent: 0, error: errMsg, text: '❌ បរាជ័យ' };
        pushJobLog(job, `❌ ភាគ ${epNum}${isRetryPass ? ' (Retry)' : ''}: ${errMsg}`);
        updateOverallProgress();
        emitSnapshot(job, true);
      } finally {
        try { if (fs.existsSync(tempEnc)) fs.unlinkSync(tempEnc); } catch (_) {}
        try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (_) {}
      }
    }

    async function runWorkerWave(epList, concurrency, isRetryPass = false) {
      activeQueueCursor = 0;
      prefetchCursor = 0;
      await prefetchNextBatch(epList);
      if (job.cancelled || signal.aborted) return;
      const prefetcherPromise = startPrefetchLoop(epList);
      const worker = async () => {
        while (activeQueueCursor < epList.length) {
          if (job.cancelled || signal.aborted) return;
          const item = epList[activeQueueCursor++];
          if (!item) break;
          await processOneEpisode(item, isRetryPass);
        }
      };
      const workerCount = Math.min(concurrency, epList.length);
      await Promise.all([
        prefetcherPromise,
        ...Array.from({ length: workerCount }, () => worker()),
      ]);
    }

    // PASS 1: High-speed parallel download + decrypt/transcode
    const pass1List = targetNums.map(num => ({
      epNum: num,
      epData: info.episodes[num - 1] || { vid_index: num },
    }));
    await runWorkerWave(pass1List, activeConcurrency, false);

    if (job.cancelled || signal.aborted) return;

    // PASS 2: Automatic gentle recovery pass for any non-VIP failed episodes
    const retryNumsAll = [...failedMap.entries()]
      .filter(([, errMsg]) => !String(errMsg || '').includes('ជាប់សោ VIP'))
      .map(([ep]) => ep)
      .sort((a, b) => a - b);
    if (retryNumsAll.length > 0) {
      const retryNums = retryNumsAll;
      job.status = 'retrying';
      job.message = `🔄 កំពុងទាញយកឡើងវិញដោយស្វ័យប្រវត្តិ ${retryNums.length} ភាគដែលបរាជ័យ...`;
      pushJobLog(job, job.message);
      emitSnapshot(job, true);

      // Clear cached failed URLs and give upstream 1.5s breathing room
      retryNums.forEach(n => playUrlMap.delete(n));
      await dl.sleep(1500, signal);
      if (job.cancelled || signal.aborted) return;

      const pass2List = retryNums.map(num => ({
        epNum: num,
        epData: info.episodes[num - 1] || { vid_index: num },
      }));
      await runWorkerWave(pass2List, Math.min(2, pass2List.length), true);
    }

    dl.syncEpisodeFileTimestamps(outputDir);

    if (job.cancelled || signal.aborted) return;

    // Optional Auto-Merge Full Movie (includes all valid downloaded episodes in folder sorted 1..N)
    if (autoMerge) {
      const allValidEntries = [];
      for (let ep = 1; ep <= totalDramaEps; ep++) {
        const f = dl.findExistingEpisodeFile(outputDir, cleanTitle, ep, totalDramaEps);
        if (f && dl.isValidMp4File(f)) {
          allValidEntries.push({ epNum: ep, file: f });
        }
      }
      if (allValidEntries.length >= 2) {
        job.status = 'merging';
        pushJobLog(job, `🎞️ ចាប់ផ្ដើមផ្គុំ Full Movie ចំនួន ${allValidEntries.length} ភាគ...`);
        emitSnapshot(job, true);
        try {
          const merged = await dl.mergeEpisodesToMovie(outputDir, cleanTitle, allValidEntries, {
            signal,
            activeChildren: job.activeChildren,
            onProgress: (pct, msg) => {
              job.progress = pct;
              job.message = msg;
              emitSnapshot(job, false);
            },
          });
          pushJobLog(job, `🎬 ផ្គុំ Full Movie ជោគជ័យ: ${path.basename(merged.path)} (${merged.sizeMb} MB)`);
        } catch (mergeErr) {
          if (job.cancelled || signal.aborted) return;
          pushJobLog(job, `⚠️ ផ្គុំ Full Movie មិនបានសម្រេច: ${mergeErr.message}`);
        }
      }
    }

    // Final honest status report
    job.completed = completedMap.size;
    job.failed = failedMap.size;
    job.failedList = [...failedMap.entries()].map(([ep, err]) => ({ ep, error: err }));
    job.progress = 100;
    job.etaSec = 0;
    job.speedMb = 0;
    job.speedText = '0.0 MB/s';
    job.finishedAt = Date.now();
    const totalTimeSec = Math.max(1, Math.round((job.finishedAt - job.startedAt) / 1000));

    if (failedMap.size === 0) {
      job.status = 'done';
      job.message = `🎉 ជោគជ័យ ១០០%! ទាញយកចប់គ្រប់ ${completedMap.size} ភាគក្នុងរយៈពេល ${totalTimeSec} វិនាទី!`;
    } else {
      job.status = 'partial';
      const failedPreview = job.failedList.slice(0, 5).map(x => `EP${x.ep}`).join(', ');
      job.message = `⚠️ បានទាញយក ${completedMap.size}/${job.total} ភាគ (បរាជ័យ ${failedMap.size} ភាគ: ${failedPreview}) — ចុច "🔄 ទាញភាគបរាជ័យឡើងវិញ"!`;
    }
    pushJobLog(job, job.message);
    emitSnapshot(job, true);
  } catch (err) {
    if (job.cancelled || signal.aborted) return;
    job.status = 'error';
    job.speedMb = 0;
    job.speedText = '0.0 MB/s';
    job.finishedAt = Date.now();
    job.message = '❌ កំហុស: ' + err.message;
    pushJobLog(job, job.message);
    emitSnapshot(job, true);
  }
}

// ===== Gemini AI Helper =====
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
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
      if (m.includes('API_KEY_INVALID') || m.includes('API key not valid')) throw err;
    }
  }
  throw lastError;
}

async function callGemini(prompt) {
  const cfg = loadConfig();
  const apiKey = cfg.GEMINI_API_KEY;
  if (!apiKey) throw new Error('មិនទាន់ដាក់ Gemini API Key — ចុច 🔑 Gemini Key ក្នុង Topbar');

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      return await callGeminiModel(model, apiKey, prompt);
    } catch (err) {
      lastError = err;
      const m = err.message || '';
      if (m.includes('API_KEY_INVALID') || m.includes('API key not valid')) throw err;
    }
  }
  throw lastError;
}

function callGeminiModel(model, apiKey, prompt) {
  const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`);
  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
  });
  return new Promise((resolve, reject) => {
    const reqG = https.request({
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 12000,
    }, (r) => {
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
    reqG.on('timeout', () => { reqG.destroy(); reject(new Error(`Model ${model} timed out`)); });
    reqG.on('error', reject);
    reqG.write(bodyStr);
    reqG.end();
  });
}

// ===== HTTP Request Body Helper =====
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// ===== HTTP Server =====
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
    try {
      const html = fs.readFileSync(PUBLIC_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500);
      return res.end('UI missing: ' + e.message);
    }
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎬</text></svg>');
  }

  // Cloud License Status & Verification API
  if (url.pathname === '/api/license/status' && req.method === 'GET') {
    const machineId = cloudLicense.getMachineHardwareId();
    const cloudEnforced = cloudLicense.isCloudLicenseEnforced();
    const summary = cloudEnforced ? cloudLicense.getCloudLicenseSummary(machineId) : null;
    const remoteSettings = (summary && summary.remoteSettings) || {};
    return sendJson(res, {
      success: true,
      isPackagedClient: IS_PACKAGED_CLIENT,
      machineId,
      cloudLicenseEnforced: cloudEnforced,
      licensed: cloudEnforced ? Boolean(summary && summary.licensed) : true,
      licenseInfo: summary
        ? {
            customerName: summary.customerName || '',
            maskedKey: summary.maskedKey || '',
            expiresAt: summary.expiresAt || null,
            appScope: summary.appScope || 'all',
          }
        : null,
      maintenanceBanner: (cloudEnforced && remoteSettings.maintenanceBanner) || '',
      downloadUrl: (cloudEnforced && remoteSettings.downloadUrl) || '',
      minAppVersion: (cloudEnforced && remoteSettings.minAppVersion) || '1.0.0',
    });
  }

  if (url.pathname === '/api/license/verify' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body && body.action === 'clear') {
      cloudLicense.clearStoredCloudLicenseState({ preserveKey: false });
      return sendJson(res, { success: true, valid: false, cleared: true });
    }

    if (!cloudLicense.isCloudLicenseEnforced()) {
      return sendJson(res, {
        success: true,
        valid: true,
        cloudLicenseEnforced: false,
        machineId: cloudLicense.getMachineHardwareId(),
      });
    }

    const machineId = cloudLicense.getMachineHardwareId();
    const providedCode = typeof body.code === 'string' ? body.code.trim() : '';
    let appVersion = '1.0.0';
    try {
      appVersion = require('./package.json').version || '1.0.0';
    } catch (_) {}

    const result = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: providedCode,
      machineId,
      appVersion,
    });

    if (!result.valid) {
      const statusCode =
        result.reason === 'maintenance'
          ? 423
          : result.reason === 'network_required'
            ? 503
            : result.reason === 'missing_key'
              ? 401
              : 403;
      return sendJson(
        res,
        {
          success: false,
          valid: false,
          cloudLicenseEnforced: true,
          reason: result.reason,
          error: result.error || 'License Key មិនត្រឹមត្រូវទេ។',
          maintenanceBanner: result.maintenanceBanner || '',
          downloadUrl: result.downloadUrl || '',
        },
        statusCode
      );
    }

    return sendJson(res, {
      success: true,
      valid: true,
      cloudLicenseEnforced: true,
      source: result.source,
      machineId,
      licenseInfo: {
        customerName: result.customerName || '',
        maskedKey: result.maskedKey || '',
        expiresAt: result.expiresAt || null,
        appScope: result.appScope || 'all',
      },
      maintenanceBanner: result.maintenanceBanner || '',
      downloadUrl: result.downloadUrl || '',
      minAppVersion: result.minAppVersion || '1.0.0',
    });
  }

  // Enforce active signed Cloud License across all API routes when enforced
  if (cloudLicense.isCloudLicenseEnforced()) {
    const machineId = cloudLicense.getMachineHardwareId();
    if (!cloudLicense.hasActiveLocalLease(machineId)) {
      return sendJson(
        res,
        {
          success: false,
          error: 'សូមផ្ទៀងផ្ទាត់ License Key ជាមុនសិន មុននឹងប្រើប្រាស់មុខងារនេះ។',
          reason: 'license_required',
          cloudLicenseEnforced: true,
        },
        403
      );
    }
  }

  // Config API
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    const key = cfg.GEMINI_API_KEY || '';
    const masked = key ? key.slice(0, 6) + '...' + key.slice(-4) : '';
    return sendJson(res, { hasKey: Boolean(key), maskedKey: masked });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const { apiKey } = await readJsonBody(req);
      const cfg = loadConfig();
      cfg.GEMINI_API_KEY = (apiKey || '').trim();
      saveConfig(cfg);
      return sendJson(res, { success: true, hasKey: Boolean(cfg.GEMINI_API_KEY) });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/test-gemini' && req.method === 'POST') {
    try {
      const { apiKey } = await readJsonBody(req);
      const key = (apiKey || loadConfig().GEMINI_API_KEY || '').trim();
      if (!key) throw new Error('សូមបញ្ចូល API Key ជាមុនសិន!');
      const text = await testGeminiKey(key);
      return sendJson(res, { success: true, message: `Key ដំណើរការល្អ! (តេស្ត: ${text})` });
    } catch (err) {
      return sendJson(res, { success: false, error: 'Key មិនត្រឹមត្រូវ: ' + err.message });
    }
  }

  if (url.pathname === '/api/sources') {
    const [ver, aria2Ver, nm3u8Ver, gpuEnc] = await Promise.all([
      ytdlp.getVersion(),
      ytdlp.getAria2Version(),
      ytdlp.getNm3u8dlVersion(),
      dl.detectGpuH264Encoder(),
    ]);
    return sendJson(res, {
      success: true,
      sources: sources.SOURCES,
      ytdlp: { available: ytdlp.isAvailable(), version: ver },
      aria2c: { available: ytdlp.isAria2Available(), version: aria2Ver, rpc: dl.getAria2RpcStatus() },
      nm3u8dl: { available: ytdlp.isNm3u8dlAvailable(), version: nm3u8Ver },
      gpu: { available: Boolean(gpuEnc), encoder: gpuEnc || null },
    });
  }

  if (url.pathname === '/api/categories') {
    const source = url.searchParams.get('source') || 'hongguo';
    if (source === 'hongguo') {
      return sendJson(res, { source, categories: CATEGORIES });
    }
    try {
      const cats = await sources.getSourceCategories(source);
      return sendJson(res, { source, categories: cats });
    } catch (err) {
      return sendJson(res, { source, categories: [{ id: '', name: '🔥 ពេញនិយម' }], error: err.message });
    }
  }

  if (url.pathname === '/api/catalog') {
    const source = url.searchParams.get('source') || 'hongguo';
    const category = url.searchParams.get('category') || (source === 'hongguo' ? 'trending' : '');
    const force = url.searchParams.get('refresh') === '1';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    if (source !== 'hongguo') {
      try {
        const resCat = await sources.browseSourceCatalog(source, { genre: category === 'trending' ? '' : category, page }, getKhmerTitle);
        return sendJson(res, {
          source,
          category,
          page,
          count: resCat.dramas.length,
          hasMore: resCat.hasMore,
          dramas: resCat.dramas,
          categories: resCat.categories,
          nextRefreshIn: 0,
        });
      } catch (err) {
        return sendJson(res, {
          source,
          category,
          page,
          count: 0,
          hasMore: false,
          dramas: [],
          error: err.message,
        });
      }
    }
    const dramas = await fetchCategoryDramas(category, page, force);
    return sendJson(res, {
      source: 'hongguo',
      category,
      page,
      count: dramas.length,
      dramas,
      nextRefreshIn: Math.max(0, Math.round((nextRefreshTimestamp - Date.now()) / 1000)),
    });
  }

  if (url.pathname === '/api/trending') {
    return sendJson(res, {
      dramas: cachedTrendingDramas,
      nextRefreshIn: Math.max(0, Math.round((nextRefreshTimestamp - Date.now()) / 1000)),
    });
  }

  if (url.pathname === '/api/refresh-trending' && req.method === 'POST') {
    await refreshTrendingDramas();
    categoryCache.clear();
    return sendJson(res, { success: true, count: cachedTrendingDramas.length, dramas: cachedTrendingDramas });
  }

  // Scanned episodes API: validates file headers/size, cleans temp junk, reports broken 0-byte files!
  if (url.pathname === '/api/scanned-episodes') {
    const sid = url.searchParams.get('seriesId');
    const force = url.searchParams.get('force') === '1';
    try {
      const info = await fetchEpisodeListSafe(sid, force);
      const cleanTitle = dl.sanitizeTitle(info.series_title, sid);
      const outputDir = path.join(getDownloadDir(), cleanTitle);
      const actualTotal = Array.isArray(info.episodes) ? info.episodes.length : 0;
      const scan = dl.scanAndCleanDramaFolder(outputDir, actualTotal, cleanTitle);
      const mergedMovies = dl.listMergedMovieFiles(outputDir, cleanTitle).map(({ path: _p, ...rest }) => rest);
      const hasMerged = mergedMovies.length > 0;
      const lockedEps = Array.isArray(info.episodes)
        ? info.episodes.filter((e) => e.locked).map((e) => Number(e.vid_index))
        : [];
      return sendJson(res, {
        success: true,
        seriesId: String(info.series_id || sid),
        source: info.source || sources.detectSourceFromId(sid),
        total: actualTotal,
        freeCount: Math.max(0, actualTotal - lockedEps.length),
        lockedEps,
        title: info.series_title,
        titleKhmer: getKhmerTitle(info.series_title),
        cover: info.cover || '',
        webAccessible: info.web_accessible_episodes ?? null,
        downloaded: scan.downloaded,
        broken: scan.broken.map(b => b.ep),
        cleanedTemp: scan.cleanedTempCount,
        hasMerged,
        mergedMovies,
        outputDir,
      });
    } catch (err) {
      return sendJson(res, { success: false, total: 0, downloaded: [], broken: [], error: err.message });
    }
  }

  // Clean 0-byte / broken files on demand
  if (url.pathname === '/api/clean-broken' && req.method === 'POST') {
    try {
      const { seriesId } = await readJsonBody(req);
      const info = await fetchEpisodeListSafe(seriesId);
      const cleanTitle = dl.sanitizeTitle(info.series_title, seriesId);
      const outputDir = path.join(getDownloadDir(), cleanTitle);
      const removed = dl.removeBrokenMp4Files(outputDir);
      return sendJson(res, { success: true, removed });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // Live Progress SSE + Multi-Job Snapshot Endpoint
  if (url.pathname === '/api/progress') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'init', snapshot: getPrimaryJobSnapshot(), jobs: getAllJobSnapshots(), summary: getJobsSummary() })}\n\n`);
    const clientId = Date.now() + Math.random();
    progressClients.push({ id: clientId, res });
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      progressClients = progressClients.filter(c => c.id !== clientId);
    });
    return;
  }

  if (url.pathname === '/api/download-status' && req.method === 'GET') {
    return sendJson(res, {
      success: true,
      snapshot: getPrimaryJobSnapshot(),
      jobs: getAllJobSnapshots(),
      summary: getJobsSummary(),
    });
  }

  if (url.pathname === '/api/library' && req.method === 'GET') {
    try {
      const items = dl.scanDramaLibrary(getDownloadDir(), buildKnownMetaByFolder());
      for (const item of items) {
        if (!findActiveJob(item.seriesId, item.folder)) {
          dl.syncEpisodeFileTimestamps(item.path);
        }
      }
      return sendJson(res, {
        success: true,
        downloadDir: getDownloadDir(),
        items,
        jobs: getAllJobSnapshots(),
        summary: getJobsSummary(),
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/library-episodes' && req.method === 'GET') {
    try {
      const folderParam = url.searchParams.get('folder');
      const sid = url.searchParams.get('seriesId');
      let targetDir = null;
      let folderName = '';
      if (folderParam) {
        targetDir = dl.resolveSafeSubdir(getDownloadDir(), folderParam);
        folderName = folderParam;
      } else if (sid) {
        const info = await fetchEpisodeListSafe(sid);
        folderName = dl.sanitizeTitle(info.series_title, sid);
        targetDir = dl.resolveSafeSubdir(getDownloadDir(), folderName);
      }
      if (!targetDir || !fs.existsSync(targetDir)) {
        return sendJson(res, { success: false, error: 'រកមិនឃើញថតវីដេអូទេ' }, 404);
      }
      const metaHint = dl.readDramaMeta(targetDir);
      if (!findActiveJob(sid || metaHint?.seriesId || '', path.basename(targetDir))) {
        dl.organizeDramaFolder(targetDir, path.basename(targetDir), Number(metaHint?.total || 0));
      }
      const data = dl.listDramaEpisodeFiles(targetDir);
      return sendJson(res, {
        success: true,
        folder: path.basename(targetDir),
        path: targetDir,
        ...data,
        mergedMovies: (data.mergedMovies || []).map(({ path: _p, ...rest }) => rest),
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/delete-library' && req.method === 'POST') {
    try {
      const { folder, epNum } = await readJsonBody(req);
      const targetDir = dl.resolveSafeSubdir(getDownloadDir(), folder);
      if (!targetDir || !fs.existsSync(targetDir)) {
        return sendJson(res, { success: false, error: 'រកមិនឃើញថតវីដេអូទេ' }, 404);
      }
      const active = findActiveJob('', path.basename(targetDir));
      if (active) {
        return sendJson(res, { success: false, error: 'មិនអាចលុបខណៈពេលកំពុងទាញយក ឬផ្គុំវីដេអូនេះបានទេ!' }, 409);
      }
      if (Number.isInteger(Number(epNum)) && Number(epNum) >= 1) {
        const f = dl.findExistingEpisodeFile(targetDir, path.basename(targetDir), Number(epNum), 0);
        if (f && fs.existsSync(f)) {
          fs.unlinkSync(f);
          const srt = f.replace(/\.mp4$/i, '.srt');
          if (fs.existsSync(srt)) try { fs.unlinkSync(srt); } catch (_) {}
        }
        return sendJson(res, { success: true, deletedEp: Number(epNum) });
      }
      fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      return sendJson(res, { success: true, deletedFolder: path.basename(targetDir) });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/resolve' && req.method === 'POST') {
    try {
      const { input, source, cookiesFromBrowser } = await readJsonBody(req);
      const resolved = await smartResolve(input, source || 'hongguo', cookiesFromBrowser || '');
      if (resolved.isSocial) {
        return sendJson(res, {
          success: true,
          isSocial: true,
          socialInfo: resolved.socialInfo,
        });
      }
      return sendJson(res, {
        success: true,
        seriesId: resolved.seriesId,
        source: resolved.source || 'hongguo',
        title: resolved.title,
        titleKhmer: resolved.titleKhmer,
        cover: resolved.cover,
        total: resolved.total,
        matches: resolved.matches || [],
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  if (url.pathname === '/api/ytdlp-probe' && req.method === 'POST') {
    try {
      const { url: targetUrl, cookiesFromBrowser } = await readJsonBody(req);
      const socialInfo = await ytdlp.probeUrl(targetUrl, { cookiesFromBrowser: cookiesFromBrowser || '' });
      return sendJson(res, { success: true, socialInfo });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  if (url.pathname === '/api/ytdlp-download' && req.method === 'POST') {
    try {
      const {
        url: targetUrl, title, cover, platform, qualityPreset,
        cookiesFromBrowser, useAria2 = true, isPlaylist, selectedIndices, totalItems,
      } = await readJsonBody(req);
      if (!ytdlp.isSocialVideoUrl(targetUrl)) {
        return sendJson(res, { success: false, error: 'សូមបញ្ចូល URL វីដេអូត្រឹមត្រូវ!' }, 400);
      }

      const platName = ytdlp.sanitizeSafeName(platform?.name || ytdlp.detectPlatform(targetUrl).name, 'Social');
      const cleanTitle = ytdlp.sanitizeSafeName(title || `${platName}_${Date.now()}`, `${platName}_${Date.now()}`);
      const folderName = `${platName} - ${cleanTitle}`.slice(0, 88);
      const outputDir = path.join(getDownloadDir(), folderName);
      const sid = `ytdlp:${Buffer.from(String(targetUrl)).toString('base64url').slice(0, 20)}`;

      const existing = findActiveJob(sid, folderName);
      if (existing) {
        return sendJson(res, { success: false, error: 'វីដេអូនេះកំពុងទាញយករួចហើយ!' }, 409);
      }

      const countTotal = isPlaylist
        ? (Array.isArray(selectedIndices) && selectedIndices.length ? selectedIndices.length : (Number(totalItems) || 1))
        : 1;

      const job = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        mode: 'ytdlp',
        status: 'starting',
        seriesId: sid,
        selectedEps: 'all',
        title: title || cleanTitle,
        titleKhmer: '',
        cover: String(cover || ''),
        folder: folderName,
        outputDir,
        total: countTotal,
        completed: 0,
        failed: 0,
        workers: 1,
        qualityMode: qualityPreset || 'best',
        autoMerge: false,
        downloadedBytes: 0,
        speedMb: 0,
        speedText: '0.0 MB/s',
        etaSec: 0,
        progress: 2,
        message: `🌐 កំពុងភ្ជាប់ទាញយកពី ${platName}...`,
        startedAt: Date.now(),
        finishedAt: null,
        lastBroadcastAt: 0,
        episodeStates: {},
        logs: [],
        failedList: [],
        cancelled: false,
        abortController: new AbortController(),
        activeChildren: new Set(),
      };
      jobsMap.set(job.id, job);
      trimFinishedJobs();
      emitSnapshot(job, true);

      (async () => {
        const signal = job.abortController.signal;
        try {
          job.status = 'running';
          if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
          dl.saveDramaMeta(outputDir, {
            seriesId: sid,
            title: job.title,
            cover: job.cover,
            source: 'ytdlp',
            platform: platName,
            isSocial: true,
            total: countTotal,
          });
          pushJobLog(job, `🌐 ចាប់ផ្ដើមទាញពី ${platName} (${qualityPreset || 'best'})${useAria2 !== false && ytdlp.isAria2Available() ? ' • ⚡ aria2c x16' : ''}${cookiesFromBrowser ? ` • Cookie: ${cookiesFromBrowser}` : ''}`);
          emitSnapshot(job, true);

          const resDl = await ytdlp.downloadYtdlp({
            url: targetUrl,
            outputDir,
            filePrefix: cleanTitle,
            isPlaylist: Boolean(isPlaylist),
            selectedIndices: Array.isArray(selectedIndices) ? selectedIndices : null,
            qualityPreset: qualityPreset || 'best',
            cookiesFromBrowser: cookiesFromBrowser || '',
            useAria2: useAria2 !== false,
            signal,
            activeChildren: job.activeChildren,
            onLog: (msg) => {
              pushJobLog(job, msg);
              emitSnapshot(job, false);
            },
            onProgress: (p) => {
              if (p.bytesDelta > 0) job.downloadedBytes += p.bytesDelta;
              job.total = p.totalItems || job.total;
              job.completed = Math.max(0, (p.currentItem || 1) - 1);
              const overall = p.totalItems > 0
                ? Math.min(99, Math.round((((p.currentItem - 1) + (p.itemPct / 100)) / p.totalItems) * 98) + 1)
                : Math.min(99, p.itemPct);
              job.progress = Math.max(job.progress, overall);
              job.speedText = p.speedText || job.speedText;
              const spNum = parseFloat(String(p.speedText || '0'));
              if (Number.isFinite(spNum) && String(p.speedText || '').includes('MB/s')) job.speedMb = spNum;
              job.message = p.phase === 'transcoding'
                ? '⚙️ កំពុងផ្គុំវីដេអូ និងសំឡេង (FFmpeg)...'
                : `⬇️ កំពុងទាញ ${p.currentItem}/${job.total} (${p.itemPct}%) • ${job.speedText}`;
              emitSnapshot(job, false);
            },
          });

          if (job.cancelled || signal.aborted) return;
          job.completed = resDl.count || job.total;
          job.progress = 100;
          job.speedMb = 0;
          job.speedText = '0.0 MB/s';
          job.status = resDl.partial ? 'partial' : 'done';
          job.finishedAt = Date.now();
          job.message = resDl.partial
            ? `⚠️ ទាញបាន ${resDl.count} ឯកសារ (មានវីដេអូខ្លះមានបញ្ហា)`
            : `✅ ទាញយករួចរាល់ពី ${platName} (${resDl.count} ឯកសារ)!`;
          pushJobLog(job, job.message);
          emitSnapshot(job, true);
        } catch (err) {
          if (job.cancelled || signal.aborted || err.message === 'CANCELLED') return;
          job.status = 'error';
          job.speedMb = 0;
          job.speedText = '0.0 MB/s';
          job.finishedAt = Date.now();
          job.message = `❌ ${err.message}`;
          pushJobLog(job, `❌ ${err.message}`);
          emitSnapshot(job, true);
        } finally {
          trimFinishedJobs();
        }
      })();

      return sendJson(res, {
        success: true,
        jobId: job.id,
        jobs: getAllJobSnapshots(),
        summary: getJobsSummary(),
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/start-download' && req.method === 'POST') {
    try {
      const {
        seriesId, selectedEps, autoMerge, workers, qualityMode,
        title, titleKhmer, cover, total,
      } = await readJsonBody(req);
      const isAllMode = selectedEps === 'all' || selectedEps == null;
      if (!seriesId || (!isAllMode && (!Array.isArray(selectedEps) || selectedEps.length === 0))) {
        return sendJson(res, { success: false, error: 'សូមជ្រើសរើសរឿង និងភាគជាមុនសិន!' }, 400);
      }

      // Only replace/guard if THIS SAME seriesId already has an active job (other dramas stay running!)
      const existingSame = findActiveJob(seriesId);
      if (existingSame) {
        if (existingSame.mode === 'merge') {
          return sendJson(res, { success: false, error: 'រឿងនេះកំពុងផ្គុំ Full Movie — សូមរង់ចាំបន្តិច!' }, 409);
        }
        cancelJob(existingSame, '🔄 ចាប់ផ្ដើមការងារទាញយកថ្មីសម្រាប់រឿងនេះ...');
        await dl.sleep(200);
      }

      const metaHint = findDramaMetaBySeriesId(seriesId);
      const finalTitle = String(title || metaHint.title || `Series ${seriesId}`);
      const finalKhmer = String(titleKhmer || metaHint.titleKhmer || getKhmerTitle(finalTitle) || '');
      const finalCover = String(cover || metaHint.cover || '');
      const estTotal = isAllMode ? (Number(total || metaHint.total || 0)) : selectedEps.length;

      const job = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        mode: 'download',
        status: 'starting',
        seriesId: String(seriesId),
        selectedEps: isAllMode ? 'all' : [...selectedEps],
        title: finalTitle,
        titleKhmer: finalKhmer,
        cover: finalCover,
        folder: dl.sanitizeTitle(finalTitle, seriesId),
        outputDir: '',
        total: estTotal,
        completed: 0,
        failed: 0,
        workers: Number(workers) || 8,
        qualityMode: qualityMode === 'fast' ? 'fast' : '1080p',
        autoMerge: Boolean(autoMerge),
        downloadedBytes: 0,
        speedMb: 0,
        speedText: '0.0 MB/s',
        etaSec: 0,
        progress: 2,
        message: '⏳ កំពុងរៀបចំប្រព័ន្ធទាញយក...',
        startedAt: Date.now(),
        finishedAt: null,
        lastBroadcastAt: 0,
        episodeStates: {},
        logs: [],
        failedList: [],
        cancelled: false,
        abortController: new AbortController(),
        activeChildren: new Set(),
      };
      jobsMap.set(job.id, job);
      trimFinishedJobs();
      emitSnapshot(job, true);
      runBatchDownload(job);
      return sendJson(res, {
        success: true,
        jobId: job.id,
        jobs: getAllJobSnapshots(),
        summary: getJobsSummary(),
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/stop-download' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body && body.jobId) {
      const target = jobsMap.get(Number(body.jobId));
      if (target && ACTIVE_JOB_STATUSES.has(target.status)) {
        cancelJob(target, '🛑 បានបញ្ឈប់ការទាញយកដោយជោគជ័យ!');
      }
    } else if (body && body.seriesId) {
      const target = findActiveJob(body.seriesId);
      if (target) cancelJob(target, '🛑 បានបញ្ឈប់ការទាញយកដោយជោគជ័យ!');
    } else {
      cancelAllActiveJobs('🛑 បានបោះបង់/ផ្អាកការទាញយកទាំងអស់!');
    }
    return sendJson(res, { success: true, jobs: getAllJobSnapshots(), summary: getJobsSummary() });
  }

  if (url.pathname === '/api/dismiss-job' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body && body.clearFinished) {
      for (const [id, j] of jobsMap.entries()) {
        if (!ACTIVE_JOB_STATUSES.has(j.status)) jobsMap.delete(id);
      }
    } else if (body && body.jobId) {
      const j = jobsMap.get(Number(body.jobId));
      if (j && !ACTIVE_JOB_STATUSES.has(j.status)) jobsMap.delete(Number(body.jobId));
    }
    emitSnapshot(null, true);
    return sendJson(res, { success: true, jobs: getAllJobSnapshots(), summary: getJobsSummary() });
  }

  // Dedicated On-Demand Full / Sequential Movie Merger (accepts seriesId OR folder + optional selectedEps / fromEp..toEp)
  if (url.pathname === '/api/merge-drama' && req.method === 'POST') {
    try {
      const { seriesId, folder, selectedEps, fromEp, toEp, outputLabel } = await readJsonBody(req);
      let sid = String(seriesId || '').trim();
      let cleanTitle = '';
      let displayTitle = '';
      let titleKhmer = '';
      let cover = '';
      let outputDir = '';
      let expectedTotal = 0;

      if (folder) {
        outputDir = dl.resolveSafeSubdir(getDownloadDir(), folder);
        if (!outputDir || !fs.existsSync(outputDir)) {
          return sendJson(res, { success: false, error: 'រកមិនឃើញថតវីដេអូសម្រាប់ផ្គុំទេ!' });
        }
        cleanTitle = path.basename(outputDir);
        const preMeta = dl.readDramaMeta(outputDir);
        expectedTotal = Number(preMeta?.total || 0);
        dl.organizeDramaFolder(outputDir, cleanTitle, expectedTotal);
        const lib = dl.listDramaEpisodeFiles(outputDir);
        sid = String(lib.meta?.seriesId || sid || '');
        displayTitle = String(lib.meta?.title || cleanTitle);
        titleKhmer = String(lib.meta?.titleKhmer || getKhmerTitle(displayTitle) || '');
        cover = String(lib.meta?.cover || '');
      } else if (sid) {
        const info = await fetchEpisodeListSafe(sid);
        cleanTitle = dl.sanitizeTitle(info.series_title, sid);
        displayTitle = info.series_title;
        titleKhmer = getKhmerTitle(displayTitle);
        cover = info.cover || '';
        expectedTotal = Array.isArray(info.episodes) ? info.episodes.length : 0;
        outputDir = path.join(getDownloadDir(), cleanTitle);
        if (fs.existsSync(outputDir)) dl.organizeDramaFolder(outputDir, cleanTitle, expectedTotal);
      } else {
        return sendJson(res, { success: false, error: 'សូមបញ្ជាក់ seriesId ឬ folder!' }, 400);
      }

      const existingSame = findActiveJob(sid, cleanTitle);
      if (existingSame) {
        return sendJson(res, { success: false, error: 'រឿងនេះកំពុងដំណើរការ — សូមរង់ចាំបញ្ចប់សិន!' }, 409);
      }

      const libFiles = dl.listDramaEpisodeFiles(outputDir);
      const allEntries = libFiles.episodes.map((e) => ({ epNum: e.epNum, file: path.join(outputDir, e.fileName) }));
      let entries = allEntries;

      if (Array.isArray(selectedEps) && selectedEps.length > 0) {
        const wanted = new Set(selectedEps.map(Number).filter((n) => Number.isInteger(n) && n >= 1));
        entries = allEntries.filter((e) => wanted.has(e.epNum)).sort((a, b) => a.epNum - b.epNum);
      } else if (fromEp != null || toEp != null) {
        const a = Math.max(1, Number(fromEp) || 1);
        const b = Number(toEp) || Number.MAX_SAFE_INTEGER;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        entries = allEntries.filter((e) => e.epNum >= lo && e.epNum <= hi).sort((a, b) => a.epNum - b.epNum);
      }

      if (entries.length < 2) {
        return sendJson(res, { success: false, error: 'ត្រូវការយ៉ាងតិច ២ ភាគដែលបានទាញយករួចរាល់ដើម្បីផ្គុំ!' });
      }

      const firstEp = entries[0].epNum;
      const lastEp = entries[entries.length - 1].epNum;
      let computedLabel = '';
      if (outputLabel && String(outputLabel).trim()) {
        computedLabel = String(outputLabel).trim();
      } else if (entries.length < allEntries.length) {
        const padLen = Math.max(3, String(expectedTotal || allEntries[allEntries.length - 1].epNum || 100).length);
        computedLabel = `EP${String(firstEp).padStart(padLen, '0')}-EP${String(lastEp).padStart(padLen, '0')}`;
      }

      const seqDesc = `EP${firstEp} → EP${lastEp}`;
      const job = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        mode: 'merge',
        status: 'merging',
        seriesId: sid,
        title: displayTitle,
        titleKhmer,
        cover,
        folder: cleanTitle,
        outputDir,
        total: entries.length,
        completed: entries.length,
        failed: 0,
        workers: 2,
        qualityMode: '1080p',
        downloadedBytes: 0,
        speedMb: 0,
        speedText: 'FFmpeg Merge',
        etaSec: 0,
        progress: 5,
        message: `🎞️ កំពុងរៀបចំផ្គុំតាមលំដាប់ ${seqDesc} (${entries.length} ភាគ)...`,
        startedAt: Date.now(),
        finishedAt: null,
        lastBroadcastAt: 0,
        episodeStates: {},
        logs: [],
        failedList: [],
        cancelled: false,
        abortController: new AbortController(),
        activeChildren: new Set(),
      };
      jobsMap.set(job.id, job);
      trimFinishedJobs();
      pushJobLog(job, job.message);
      emitSnapshot(job, true);

      (async () => {
        try {
          const result = await dl.mergeEpisodesToMovie(outputDir, cleanTitle, entries, {
            outputLabel: computedLabel,
            signal: job.abortController.signal,
            activeChildren: job.activeChildren,
            onProgress: (pct, msg) => {
              job.progress = pct >= 100 ? 100 : Math.min(99, Math.max(8, Math.round(((pct - 88) / 12) * 90 + 10)));
              job.message = msg;
              if (msg) pushJobLog(job, msg);
              emitSnapshot(job, false);
            },
          });
          job.status = 'done';
          job.progress = 100;
          job.finishedAt = Date.now();
          job.message = `🎬 ផ្គុំតាមលំដាប់រួចរាល់: ${result.fileName} (${result.sizeMb} MB)`;
          pushJobLog(job, job.message);
          emitSnapshot(job, true);
        } catch (err) {
          if (!job.cancelled) {
            job.status = 'error';
            job.finishedAt = Date.now();
            job.message = '❌ ផ្គុំបរាជ័យ: ' + err.message;
            pushJobLog(job, job.message);
            emitSnapshot(job, true);
          }
        }
      })();

      return sendJson(res, {
        success: true,
        jobId: job.id,
        count: entries.length,
        firstEp,
        lastEp,
        outputLabel: computedLabel || 'Full Movie',
        jobs: getAllJobSnapshots(),
        summary: getJobsSummary(),
      });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // Stream downloaded MP4 episode (or merged movie with ?full=1&mergedFile=...), supports folder OR seriesId!
  if (url.pathname === '/api/video' && req.method === 'GET') {
    const sid = url.searchParams.get('seriesId');
    const folderParam = url.searchParams.get('folder');
    const isFull = url.searchParams.get('full') === '1';
    const mergedFile = url.searchParams.get('mergedFile') || '';
    const ep = parseInt(url.searchParams.get('ep') || '1', 10);
    try {
      let filePath = null;
      if (folderParam) {
        const outputDir = dl.resolveSafeSubdir(getDownloadDir(), folderParam);
        if (!outputDir || !fs.existsSync(outputDir)) {
          res.writeHead(404);
          return res.end('Video folder not found');
        }
        const safeName = path.basename(outputDir);
        filePath = isFull
          ? dl.findMergedMovieFile(outputDir, safeName, mergedFile)
          : dl.findMediaFileForPlayback(outputDir, safeName, ep, 0);
      } else {
        const info = await fetchEpisodeListSafe(sid);
        const cleanTitle = dl.sanitizeTitle(info.series_title, sid);
        const outputDir = path.join(getDownloadDir(), cleanTitle);
        filePath = isFull
          ? dl.findMergedMovieFile(outputDir, cleanTitle, mergedFile)
          : dl.findMediaFileForPlayback(outputDir, cleanTitle, ep, info.episodes.length);
      }
      if (!filePath || !dl.isPlayableMediaFile(filePath)) {
        res.writeHead(404);
        return res.end('Video not found or incomplete');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === '.mp3' ? 'audio/mpeg'
        : ext === '.m4a' ? 'audio/mp4'
        : ext === '.webm' ? 'video/webm'
        : ext === '.mkv' ? 'video/x-matroska'
        : 'video/mp4';
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10) || 0;
        const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': (end - start) + 1,
          'Content-Type': mimeType,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    } catch (err) {
      res.writeHead(500);
      return res.end(err.message);
    }
  }

  if (url.pathname === '/api/open-folder') {
    let targetPath = getDownloadDir();
    try {
      const { title, folder } = await readJsonBody(req);
      if (folder) {
        const safeSub = dl.resolveSafeSubdir(targetPath, folder);
        if (safeSub && fs.existsSync(safeSub)) targetPath = safeSub;
      } else if (title) {
        const cleanTitle = dl.sanitizeTitle(title);
        const dramaDir = path.join(targetPath, cleanTitle);
        if (fs.existsSync(dramaDir)) targetPath = dramaDir;
      }
    } catch (_) {}
    try {
      if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
      const p = spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
      p.unref();
    } catch (_) {
      try { exec(`start "" "${targetPath}"`); } catch (_) {}
    }
    return sendJson(res, { success: true, path: targetPath });
  }

  if (url.pathname === '/api/download-dir') {
    if (req.method === 'POST') {
      try {
        const { path: newPath } = await readJsonBody(req);
        if (!newPath || typeof newPath !== 'string') throw new Error('ទីតាំងមិនត្រឹមត្រូវ');
        const clean = path.normalize(newPath.trim());
        if (!fs.existsSync(clean)) fs.mkdirSync(clean, { recursive: true });
        saveConfig({ DOWNLOAD_DIR: clean });
        return sendJson(res, { success: true, path: clean });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message });
      }
    }
    return sendJson(res, { success: true, path: getDownloadDir() });
  }

  if (url.pathname === '/api/list-dirs' && req.method === 'GET') {
    try {
      const home = os.homedir();
      const drives = [];
      for (let code = 67; code <= 90; code++) {
        const drv = `${String.fromCharCode(code)}:\\`;
        try { if (fs.existsSync(drv)) drives.push(drv); } catch (_) {}
      }
      const rawShortcuts = [
        { label: '⬇️ Downloads', path: path.join(home, 'Downloads') },
        { label: '🖥️ Desktop', path: path.join(home, 'Desktop') },
        { label: '📄 Documents', path: path.join(home, 'Documents') },
        { label: '🎬 ថតបច្ចុប្បន្ន', path: getDownloadDir() },
        { label: '📁 ថតលំនាំដើម', path: DEFAULT_DOWNLOAD_DIR },
      ];
      const seenShort = new Set();
      const shortcuts = [];
      for (const s of rawShortcuts) {
        const p = path.normalize(s.path);
        if (!seenShort.has(p.toLowerCase()) && fs.existsSync(p)) {
          seenShort.add(p.toLowerCase());
          shortcuts.push({ label: s.label, path: p });
        }
      }

      let reqPath = (url.searchParams.get('path') || '').trim();
      if (!reqPath || !fs.existsSync(reqPath)) {
        reqPath = getDownloadDir();
        if (!fs.existsSync(reqPath)) reqPath = home;
      }
      const current = path.normalize(reqPath);
      const parsedRoot = path.parse(current).root;
      const parent = current.toLowerCase() !== parsedRoot.toLowerCase() ? path.dirname(current) : null;

      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) {}

      const folders = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
        folders.push({
          name: entry.name,
          path: path.join(current, entry.name),
        });
      }
      folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

      return sendJson(res, {
        success: true,
        current,
        parent,
        drives,
        shortcuts,
        folders: folders.slice(0, 250),
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (url.pathname === '/api/create-folder' && req.method === 'POST') {
    try {
      const { parentPath, name } = await readJsonBody(req);
      const cleanName = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!parentPath || !cleanName || cleanName === '.' || cleanName === '..') {
        throw new Error('ឈ្មោះថតមិនត្រឹមត្រូវ');
      }
      const target = path.join(path.normalize(parentPath), cleanName);
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      return sendJson(res, { success: true, path: target });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 400);
    }
  }

  if (url.pathname === '/api/browse-folder' && req.method === 'POST') {
    try {
      const chosen = await promptFolderPicker(getDownloadDir());
      if (chosen) {
        const clean = path.normalize(chosen.trim());
        if (!fs.existsSync(clean)) fs.mkdirSync(clean, { recursive: true });
        saveConfig({ DOWNLOAD_DIR: clean });
        return sendJson(res, { success: true, path: clean });
      }
      return sendJson(res, { success: false, cancelled: true });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message });
    }
  }

  if (url.pathname === '/download/tool') {
    if (IS_PACKAGED_CLIENT) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const exeFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.exe'));
    if (exeFiles.length === 0) {
      return sendJson(res, { error: 'មិនរកឃើញ setup.exe' }, 404);
    }
    const exeFile = exeFiles[0];
    const exePath = path.join(__dirname, exeFile);
    const stat = fs.statSync(exePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${exeFile}"; filename*=UTF-8''${encodeURIComponent(exeFile)}`,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(exePath).pipe(res);
  }

  if (url.pathname === '/api/gemini-translate' && req.method === 'POST') {
    try {
      const { title } = await readJsonBody(req);
      if (!title) return sendJson(res, { error: 'title required' }, 400);
      const prompt = `You are a Khmer drama translator. Translate this Chinese drama title to natural Khmer language (ភាសាខ្មែរ). Return ONLY the Khmer translation, no explanation, no Chinese characters, no romanization.\nChinese title: "${title}"\nKhmer translation:`;
      const khmer = await callGemini(prompt);
      return sendJson(res, { khmer });
    } catch (err) {
      return sendJson(res, { error: err.message });
    }
  }

  if (url.pathname === '/api/gemini-synopsis' && req.method === 'POST') {
    try {
      const { title } = await readJsonBody(req);
      if (!title) return sendJson(res, { error: 'title required' }, 400);
      const prompt = `You are a Khmer drama expert. Based on this Chinese drama title, write a short 2-3 sentence synopsis in natural Khmer language (ភាសាខ្មែរ). Return ONLY Khmer text.\nDrama title: "${title}"\nKhmer synopsis:`;
      const synopsis = await callGemini(prompt);
      return sendJson(res, { synopsis });
    } catch (err) {
      return sendJson(res, { error: err.message });
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

function runBackgroundWarmup() {
  if (!cloudLicense.isCloudLicenseEnforced() || cloudLicense.hasActiveLocalLease()) {
    startCatalogWarmup();
  }
  dl.ensureAria2Daemon().then((st) => {
    console.log(`[Warmup] aria2c RPC daemon ready on 127.0.0.1:${st.port}`);
  }).catch(() => {});
  dl.detectGpuH264Encoder().then((enc) => {
    if (enc) console.log(`[Warmup] GPU encoder ready: ${enc}`);
  }).catch(() => {});
  (async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await getPlaybackDevice(appRequestJson);
        console.log('[Warmup] Playback device registered and cached.');
        break;
      } catch (_) {
        await dl.sleep(10500);
      }
    }
  })();
}

function startServer({ port = PORT, host = '127.0.0.1', warmUp = true } = {}) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const addr = server.address();
      return resolve({ server, port: addr && typeof addr === 'object' ? addr.port : port });
    }
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      server.requestTimeout = 0;
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      console.log(`EZA PRO Downloader running at: http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);
      if (warmUp) runBackgroundWarmup();
      resolve({ server, port: actualPort });
    });
  });
}

function stopServer() {
  stopCatalogWarmup();
  try {
    cancelAllActiveJobs('🛑 កម្មវិធីកំពុងបិទ');
  } catch (_) {}
  try {
    dl.shutdownAria2Daemon();
  } catch (_) {}
  try {
    for (const c of progressClients) {
      try { c.res.end(); } catch (_) {}
    }
    progressClients = [];
  } catch (_) {}
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch (_) {}
  try {
    if (server.listening) server.close();
  } catch (_) {}
}

if (require.main === module) {
  startServer({ port: PORT, host: '0.0.0.0', warmUp: true });
  const exitNow = () => {
    stopServer();
    process.exit(0);
  };
  process.on('SIGINT', exitNow);
  process.on('SIGTERM', exitNow);
}

module.exports = {
  server,
  startServer,
  stopServer,
  setFolderPickerHandler,
  loadConfig,
  saveConfig,
  getDownloadDir,
};
