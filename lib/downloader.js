const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { gzipSync } = require('zlib');

const axios = require('axios');
const {
  fetchEpisodeList,
  fetchPlayUrlSingle,
  fetchPlayUrlFromWeb,
  deriveKey,
  decryptMp4File,
  VIDEO_REFERER,
  WEB_UA,
  WEB_REFERER,
} = require('../hongguo-drama/src/native/hongguo');
const { fetchAppPlayUrl, requestJson: appRequestJson } = require('../hongguo-drama/src/native/app-source');
const { getPlaybackDevice } = require('../hongguo-drama/src/native/playback-device');
const { signPlayer } = require('../hongguo-drama/src/native/playback-signature');
const { remuxHls } = require('../hongguo-drama/src/native/hls-media');
const sources = require('./sources');
const ytdlp = require('./ytdlp');
const aria2Rpc = require('./aria2_rpc');

const BIN_DIR = ytdlp.BIN_DIR;
const LEGACY_FFMPEG_DIR = path.join(__dirname, '..', 'hongguo-drama', 'build', 'ffmpeg');
const FFMPEG_EXE = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))
  ? path.join(BIN_DIR, 'ffmpeg.exe')
  : path.join(LEGACY_FFMPEG_DIR, 'ffmpeg.exe');
const LIBREMPEG_EXE = path.join(LEGACY_FFMPEG_DIR, 'librempeg.exe');
const FFPROBE_EXE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe'))
  ? path.join(BIN_DIR, 'ffprobe.exe')
  : path.join(LEGACY_FFMPEG_DIR, 'ffprobe.exe');

const MIN_VALID_MP4_BYTES = 30 * 1024; // 30 KB (catches 0-byte and HTML error pages while keeping valid short clips)

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeTitle(title, fallbackId = '') {
  return String(title || ('Drama_' + fallbackId))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveEpisodeFileName(cleanTitle, epNum, totalEps) {
  const padLen = Math.max(3, String(totalEps || 100).length);
  const padNum = String(epNum).padStart(padLen, '0');
  return `EP${padNum}.mp4`;
}

function resolveMergedMoviePath(outputDir, cleanTitle, label = '') {
  const safeLabel = String(label || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const suffix = safeLabel || 'Full Movie';
  return path.join(outputDir, 'Full Movie', `${cleanTitle} - ${suffix}.mp4`);
}

function listMergedMovieFiles(outputDir, cleanTitle) {
  if (!outputDir || !cleanTitle) return [];
  const results = [];
  const seen = new Set();

  function pushFile(fullPath, relPath) {
    if (!fullPath || seen.has(fullPath) || !isValidMp4File(fullPath)) return;
    seen.add(fullPath);
    const stat = fs.statSync(fullPath);
    const fileName = path.basename(fullPath);
    const rangeMatch = fileName.match(/EP0*(\d+)\s*-\s*EP0*(\d+)/i);
    const startEp = rangeMatch ? parseInt(rangeMatch[1], 10) : null;
    const endEp = rangeMatch ? parseInt(rangeMatch[2], 10) : null;
    const label = rangeMatch
      ? `EP${rangeMatch[1].padStart(3, '0')}-EP${rangeMatch[2].padStart(3, '0')}`
      : 'រឿងពេញ';
    results.push({
      fileName,
      relPath,
      path: fullPath,
      label,
      startEp,
      endEp,
      isFullAll: !rangeMatch,
      sizeMb: Number((stat.size / (1024 * 1024)).toFixed(1)),
      mtimeMs: stat.mtimeMs,
    });
  }

  const fullDir = path.join(outputDir, 'Full Movie');
  if (fs.existsSync(fullDir)) {
    try {
      for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.mp4')) continue;
        if (/^temp_/i.test(entry.name)) continue;
        pushFile(path.join(fullDir, entry.name), `Full Movie/${entry.name}`);
      }
    } catch (_) {}
  }

  pushFile(path.join(outputDir, `${cleanTitle}_រឿងពេញចប់.mp4`), `${cleanTitle}_រឿងពេញចប់.mp4`);

  results.sort((a, b) => {
    if (a.startEp !== null && b.startEp !== null) return a.startEp - b.startEp;
    if (a.isFullAll !== b.isFullAll) return a.isFullAll ? -1 : 1;
    return a.fileName.localeCompare(b.fileName);
  });
  return results;
}

function findMergedMovieFile(outputDir, cleanTitle, preferredFileName = '') {
  if (!outputDir || !cleanTitle) return null;
  if (preferredFileName) {
    const base = path.basename(String(preferredFileName).trim());
    if (!base || base === '.' || base === '..') return null;
    const direct = [
      path.join(outputDir, 'Full Movie', base),
      path.join(outputDir, base),
    ];
    for (const p of direct) {
      if (isValidMp4File(p)) return p;
    }
    return null;
  }
  const candidates = [
    resolveMergedMoviePath(outputDir, cleanTitle),
    path.join(outputDir, `${cleanTitle}_រឿងពេញចប់.mp4`),
    ...listMergedMovieFiles(outputDir, cleanTitle).map((x) => x.path),
  ];
  for (const p of candidates) {
    if (isValidMp4File(p)) return p;
  }
  return null;
}

function hasMergedMovie(outputDir, cleanTitle) {
  return Boolean(findMergedMovieFile(outputDir, cleanTitle));
}

function parseEpisodeNumberFromFileName(fileName) {
  if (!fileName || !fileName.toLowerCase().endsWith('.mp4')) return null;
  if (/^temp_|^concat_list/i.test(fileName)) return null;
  if (/(?:រឿងពេញ|full[\s_-]*movie)/i.test(fileName)) return null;
  const epMatch = fileName.match(/^EP0*(\d+)(?:\s*[-_].*)?\.mp4$/i)
    || fileName.match(/^(?:Episode|ភាគ)[\s_-]*0*(\d+)(?:\s*[-_].*)?\.mp4$/i)
    || fileName.match(/^0*(\d{1,4})\.mp4$/)
    || fileName.match(/(?:^|_)第0*(\d+)集\.mp4$/);
  return epMatch ? parseInt(epMatch[1], 10) : null;
}

/**
 * Find any matching valid episode file on disk (supports EP001, EP01, and legacy _第001集).
 */
function findExistingEpisodeFile(outputDir, cleanTitle, epNum, totalEps) {
  const canonical = path.join(outputDir, resolveEpisodeFileName(cleanTitle, epNum, totalEps));
  if (fs.existsSync(canonical)) return canonical;
  if (!fs.existsSync(outputDir)) return null;
  try {
    const files = fs.readdirSync(outputDir);
    for (const f of files) {
      if (parseEpisodeNumberFromFileName(f) === epNum) {
        return path.join(outputDir, f);
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Check if a file starts with a valid MP4 signature (not HTML/JSON error text) and meets minimum size.
 */
function isValidMp4File(filePath, minBytes = MIN_VALID_MP4_BYTES) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < minBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    const boxType = header.subarray(4, 8).toString('latin1');
    // Standard MP4 top-level boxes: ftyp, wide, free, mdat, moov, styp, sidx
    if (['ftyp', 'wide', 'free', 'mdat', 'moov', 'styp', 'sidx', 'skip'].includes(boxType)) {
      return true;
    }
    // Reject obvious HTML / JSON error responses
    const textHead = header.toString('utf8').trimStart();
    if (textHead.startsWith('<') || textHead.startsWith('{') || textHead.startsWith('[')) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function isPlayableMediaFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return isValidMp4File(filePath);
  if (['.mp3', '.m4a', '.webm', '.mkv'].includes(ext)) {
    try { return fs.statSync(filePath).size >= 4096; } catch (_) { return false; }
  }
  return false;
}

function findMediaFileForPlayback(dramaDir, cleanTitle, epNum, totalEps = 0) {
  const direct = findExistingEpisodeFile(dramaDir, cleanTitle, epNum, totalEps);
  if (direct && isValidMp4File(direct)) return direct;
  const info = listDramaEpisodeFiles(dramaDir);
  const found = (info.episodes || []).find((e) => Number(e.epNum) === Number(epNum));
  if (found) {
    const full = path.join(dramaDir, found.fileName);
    if (isPlayableMediaFile(full)) return full;
  }
  return null;
}

/**
 * Organize a drama folder cleanly: standardize valid episodes to EP001.mp4 and move full movies to Full Movie/.
 */
function organizeDramaFolder(outputDir, cleanTitle, totalEps = 0) {
  if (!fs.existsSync(outputDir) || !cleanTitle) return;
  const meta = readDramaMeta(outputDir);
  if (meta && meta.isSocial) return;
  const files = fs.readdirSync(outputDir);
  for (const f of files) {
    const full = path.join(outputDir, f);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch (_) {
      continue;
    }

    // Move legacy Full Movie out of episode list into Full Movie/ subfolder
    if (/(?:_រឿងពេញចប់|Full[\s_-]*Movie)\.mp4$/i.test(f) && isValidMp4File(full)) {
      const targetFull = resolveMergedMoviePath(outputDir, cleanTitle);
      const targetDir = path.dirname(targetFull);
      try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (!fs.existsSync(targetFull)) fs.renameSync(full, targetFull);
      } catch (_) {}
      continue;
    }

    const ep = parseEpisodeNumberFromFileName(f);
    if (ep !== null && isValidMp4File(full)) {
      const targetName = resolveEpisodeFileName(cleanTitle, ep, totalEps);
      if (f !== targetName) {
        const targetPath = path.join(outputDir, targetName);
        if (!fs.existsSync(targetPath)) {
          try {
            fs.renameSync(full, targetPath);
            // Keep matching .srt sidecar synchronized if present
            const oldSrt = full.replace(/\.mp4$/i, '.srt');
            const newSrt = targetPath.replace(/\.mp4$/i, '.srt');
            if (fs.existsSync(oldSrt) && !fs.existsSync(newSrt)) {
              fs.renameSync(oldSrt, newSrt);
            }
          } catch (_) {}
        }
      }
    }
  }
  syncEpisodeFileTimestamps(outputDir);
}

/**
 * Ensure episode files have monotonically ascending mtime in strict 1 -> N order
 * so Explorer, Gallery, and Video Editors never scramble concurrent downloads by timestamp.
 */
function syncEpisodeFileTimestamps(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return false;
  const items = [];
  try {
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ep = parseEpisodeNumberFromFileName(entry.name);
      if (ep === null) continue;
      const full = path.join(outputDir, entry.name);
      if (!isValidMp4File(full)) continue;
      const stat = fs.statSync(full);
      items.push({ ep, full, mtimeMs: stat.mtimeMs });
    }
  } catch (_) {
    return false;
  }
  if (items.length < 2) return false;
  items.sort((a, b) => a.ep - b.ep);

  let needsSync = false;
  let maxMtimeMs = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].mtimeMs > maxMtimeMs) maxMtimeMs = items[i].mtimeMs;
    if (i > 0 && items[i].mtimeMs <= items[i - 1].mtimeMs + 500) {
      needsSync = true;
    }
  }
  if (!needsSync) return false;

  const anchorSec = Math.floor((maxMtimeMs || Date.now()) / 1000);
  const baseSec = Math.max(100000, anchorSec - items.length * 2);
  for (let i = 0; i < items.length; i++) {
    const t = new Date((baseSec + i * 2) * 1000);
    try {
      fs.utimesSync(items[i].full, t, t);
      const srt = items[i].full.replace(/\.mp4$/i, '.srt');
      if (fs.existsSync(srt)) fs.utimesSync(srt, t, t);
    } catch (_) {}
  }
  return true;
}

/**
 * Clean orphaned temp files and 0-byte / corrupted MP4s in a drama output folder.
 */
function scanAndCleanDramaFolder(outputDir, totalEps = 0, cleanTitle = '') {
  const downloaded = [];
  const broken = [];
  let cleanedTempCount = 0;

  if (!fs.existsSync(outputDir)) {
    return { downloaded, broken, cleanedTempCount };
  }

  for (const f of fs.readdirSync(outputDir)) {
    const full = path.join(outputDir, f);
    if (/^(?:temp_(?:ep|out|norm|merged)_\d+.*|concat_list_\d+\.txt)$/i.test(f)) {
      try {
        fs.unlinkSync(full);
        cleanedTempCount++;
      } catch (_) {}
    }
  }

  if (cleanTitle) {
    organizeDramaFolder(outputDir, cleanTitle, totalEps);
  }

  const files = fs.readdirSync(outputDir);
  for (const f of files) {
    const full = path.join(outputDir, f);
    const ep = parseEpisodeNumberFromFileName(f);
    if (ep !== null) {
      if (totalEps > 0 && ep > totalEps) continue;
      if (isValidMp4File(full)) {
        if (!downloaded.includes(ep)) downloaded.push(ep);
      } else {
        broken.push({ ep, file: full, size: fs.existsSync(full) ? fs.statSync(full).size : 0 });
      }
    }
  }

  downloaded.sort((a, b) => a - b);
  broken.sort((a, b) => a.ep - b.ep);
  return { downloaded, broken, cleanedTempCount };
}

function removeBrokenMp4Files(outputDir) {
  if (!fs.existsSync(outputDir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(outputDir)) {
    const full = path.join(outputDir, f);
    if (/^(?:temp_(?:ep|out|norm|merged)_\d+.*|concat_list_\d+\.txt)$/i.test(f)) {
      try { fs.unlinkSync(full); removed++; } catch (_) {}
      continue;
    }
    if (parseEpisodeNumberFromFileName(f) !== null && !isValidMp4File(full)) {
      try { fs.unlinkSync(full); removed++; } catch (_) {}
    }
  }
  return removed;
}

const META_FILE_NAME = '.hdrg_meta.json';
const IGNORED_LIBRARY_DIRS = new Set([
  'node_modules', 'hongguo-drama', 'lib', 'public', 'exported', 'build', '.git', '.vscode',
]);

/**
 * Resolve a drama subdirectory safely strictly within rootDir.
 */
function resolveSafeSubdir(rootDir, folderName) {
  const name = String(folderName || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) return null;
  const resolvedRoot = path.resolve(rootDir);
  const candidate = path.resolve(resolvedRoot, name);
  if (!candidate.startsWith(resolvedRoot + path.sep)) return null;
  return candidate;
}

function readDramaMeta(outputDir) {
  try {
    const p = path.join(outputDir, META_FILE_NAME);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (_) {
    return null;
  }
}

/**
 * Persist lightweight drama metadata in its download folder for fast offline Video Management.
 */
function saveDramaMeta(outputDir, meta = {}) {
  try {
    if (!outputDir || !meta || typeof meta !== 'object') return;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const prev = readDramaMeta(outputDir) || {};
    const merged = {
      seriesId: String(meta.seriesId || prev.seriesId || ''),
      title: String(meta.title || prev.title || ''),
      titleKhmer: String(meta.titleKhmer || prev.titleKhmer || ''),
      cover: String(meta.cover || prev.cover || ''),
      total: Number(meta.total || prev.total || 0),
      source: String(meta.source || prev.source || ''),
      platform: String(meta.platform || prev.platform || ''),
      isSocial: Boolean(meta.isSocial !== undefined ? meta.isSocial : prev.isSocial),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(path.join(outputDir, META_FILE_NAME), JSON.stringify(merged, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * List valid downloaded episode MP4s and optional Full Movie inside a drama folder.
 */
function listDramaEpisodeFiles(dramaDir) {
  const episodes = [];
  let totalBytes = 0;
  let updatedAt = 0;
  if (!dramaDir || !fs.existsSync(dramaDir)) {
    return { episodes, mergedMovie: null, totalBytes: 0, updatedAt: 0, meta: null };
  }

  const meta = readDramaMeta(dramaDir);
  const folderName = path.basename(dramaDir);
  const seenEp = new Set();
  for (const entry of fs.readdirSync(dramaDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ep = parseEpisodeNumberFromFileName(entry.name);
    if (ep === null || seenEp.has(ep)) continue;
    const full = path.join(dramaDir, entry.name);
    if (!isValidMp4File(full)) continue;
    seenEp.add(ep);
    const stat = fs.statSync(full);
    totalBytes += stat.size;
    if (stat.mtimeMs > updatedAt) updatedAt = stat.mtimeMs;
    episodes.push({
      epNum: ep,
      fileName: entry.name,
      sizeMb: Number((stat.size / (1024 * 1024)).toFixed(1)),
      mtimeMs: stat.mtimeMs,
    });
  }
  if (episodes.length === 0 && meta && meta.isSocial) {
    const mediaEntries = fs.readdirSync(dramaDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mp4|mkv|webm|mp3|m4a)$/i.test(e.name) && !/^temp_|\.part$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    let idx = 1;
    for (const entry of mediaEntries) {
      const full = path.join(dramaDir, entry.name);
      if (!isPlayableMediaFile(full)) continue;
      const stat = fs.statSync(full);
      totalBytes += stat.size;
      if (stat.mtimeMs > updatedAt) updatedAt = stat.mtimeMs;
      episodes.push({
        epNum: idx++,
        fileName: entry.name,
        isAudio: /\.(mp3|m4a)$/i.test(entry.name),
        sizeMb: Number((stat.size / (1024 * 1024)).toFixed(1)),
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  episodes.sort((a, b) => a.epNum - b.epNum);

  const mergedMovies = listMergedMovieFiles(dramaDir, folderName);
  const mergedMovie = mergedMovies.find((m) => m.isFullAll) || mergedMovies[0] || null;
  for (const mm of mergedMovies) {
    if (mm.mtimeMs > updatedAt) updatedAt = mm.mtimeMs;
  }

  return {
    episodes,
    mergedMovie,
    mergedMovies,
    totalBytes,
    updatedAt,
    meta,
  };
}

/**
 * Scan download root for all downloaded drama folders with stats and merged-movie status.
 */
function scanDramaLibrary(rootDir, knownMetaByFolder = new Map()) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    if (folder.startsWith('.') || folder.startsWith('$') || IGNORED_LIBRARY_DIRS.has(folder.toLowerCase())) continue;

    const dirPath = path.join(rootDir, folder);
    const info = listDramaEpisodeFiles(dirPath);
    const known = knownMetaByFolder instanceof Map ? knownMetaByFolder.get(folder) : null;
    const meta = info.meta || known || null;
    if (!info.episodes.length && !info.mergedMovies.length && !info.meta) continue;

    let folderMtime = info.updatedAt;
    if (!folderMtime) {
      try { folderMtime = fs.statSync(dirPath).mtimeMs; } catch (_) {}
    }
    const mergedBytes = info.mergedMovies.reduce((sum, mm) => sum + Math.round((mm.sizeMb || 0) * 1024 * 1024), 0);
    const combinedBytes = info.totalBytes + mergedBytes;

    items.push({
      folder,
      path: dirPath,
      seriesId: String(meta?.seriesId || known?.seriesId || ''),
      title: String(meta?.title || known?.title || folder),
      titleKhmer: String(meta?.titleKhmer || known?.titleKhmer || ''),
      cover: String(meta?.cover || known?.cover || ''),
      source: String(meta?.source || known?.source || ''),
      platform: String(meta?.platform || known?.platform || ''),
      isSocial: Boolean(meta?.isSocial),
      expectedTotal: Number(meta?.total || known?.total || 0),
      downloadedCount: info.episodes.length,
      downloadedEps: info.episodes.map((e) => e.epNum),
      totalSizeMb: Number((info.totalBytes / (1024 * 1024)).toFixed(1)),
      combinedSizeMb: Number((combinedBytes / (1024 * 1024)).toFixed(1)),
      hasMerged: Boolean(info.mergedMovies.length > 0),
      mergedMovie: info.mergedMovie,
      mergedMovies: info.mergedMovies.map(({ path: _p, ...rest }) => rest),
      updatedAt: Number(meta?.updatedAt || folderMtime || 0),
    });
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/**
 * Build candidate stream descriptors (preserving codec, contentKey, userAgent, referer per variant).
 */
function parsePixels(q) {
  const m = String(q || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function extractVariants(play, qualityMode = '1080p') {
  if (!play) return [];
  const list = [];
  const seen = new Set();

  const pushCandidate = (item) => {
    if (!item || !item.url || seen.has(item.url)) return;
    const src = item.source || play.source || 'app';
    const isHongguo = ['hongguo', 'app', 'web'].includes(src);
    // Hema CDN (cbread.cn) stalls TLS renegotiation from overseas; prefer plain HTTP with HTTPS fallback.
    const urlsToPush = (!isHongguo && /^https:\/\/[^/]*cbread\.cn\//i.test(item.url))
      ? [item.url.replace(/^https:\/\//i, 'http://'), item.url]
      : [item.url];

    for (const candidateUrl of urlsToPush) {
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      list.push({
        url: candidateUrl,
        format: (item.format || play.format || (/\.m3u8(\?|$)/i.test(candidateUrl) ? 'hls' : 'mp4')).toLowerCase(),
        contentKey: item.contentKey ?? play.contentKey ?? null,
        spadeA: item.spadeA ?? play.spadeA ?? null,
        codec: (item.codec || play.codec || '').toLowerCase(),
        quality: item.quality || play.quality || '',
        pixels: parsePixels(item.quality || play.quality || ''),
        duration: Number(item.duration || play.duration) || 0,
        userAgent: item.userAgent || play.userAgent || WEB_UA,
        referer: item.referer || play.referer || (isHongguo ? (play.source === 'web' ? WEB_REFERER : VIDEO_REFERER) : ''),
        source: src,
      });
    }
  };

  if (Array.isArray(play.variants)) {
    for (const v of play.variants) pushCandidate(v);
  }
  pushCandidate(play);

  const isFast = qualityMode === 'fast';
  // Rank streams cleanly:
  // 1) Non-bytevc2 (h264/hevc) always beats bytevc2 because stream-copy is instant & lossless
  // 2) For fast mode on bytevc2: prefer 576p/540p/480p (3-6s transcode) over 720p (~27s transcode) > 1080p
  // 3) For h264/hevc (or 1080p mode): prefer highest resolution (1080p+)
  // 4) Prefer fast v3 CDN edges
  list.sort((a, b) => {
    const aB2 = a.codec === 'bytevc2' ? 1 : 0;
    const bB2 = b.codec === 'bytevc2' ? 1 : 0;
    if (aB2 !== bB2) return aB2 - bB2;

    if (isFast && aB2 === 1 && bB2 === 1) {
      const rankFastB2 = (px) => (px === 576 ? 2200 : px === 540 ? 2000 : px === 480 ? 1800 : px === 720 ? 1500 : px === 1080 ? 1200 : px);
      const rDiff = rankFastB2(b.pixels) - rankFastB2(a.pixels);
      if (rDiff !== 0) return rDiff;
    } else if (b.pixels !== a.pixels) {
      return b.pixels - a.pixels;
    }

    const cdnScore = (u) => (u.includes('v3-') ? 4 : ((u.includes('v26-') || u.includes('v9-')) ? 2 : 1));
    return cdnScore(b.url) - cdnScore(a.url);
  });

  return list;
}

const APP_VIDEO_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const APP_PLAYBACK_UA = 'com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const APP_PLAYBACK_DEVICE = {
  ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread',
  version_code: '74332', version_name: '7.4.3.32', device_platform: 'android', os: 'android',
  ssmix: 'a', device_type: '25053RT47C', device_brand: 'Redmi', language: 'zh', os_api: '36',
  os_version: '16', manifest_version_code: '74332', resolution: '1280*2772', dpi: '520',
  update_version_code: '74332', host_abi: 'arm64-v8a', dragon_device_type: 'phone', pv_player: '74332',
  compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
};
const ALLOWED_VOD_DOMAINS = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];

function encodePythonQuery(values) {
  return Object.entries(values).map(([key, value]) => {
    const encode = (v) => encodeURIComponent(String(v == null ? '' : v))
      .replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${encode(key)}=${encode(value)}`;
  }).join('&');
}

function cleanBatchMediaUrl(value) {
  return String(value == null ? '' : value).trim()
    .replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}

function deriveAppContentKeyHex(value) {
  const raw = Buffer.from(String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length < 3) return null;
  let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  v8 = Math.min(v8, raw.length - 1);
  if (v8 < 33) return null;
  const work = Buffer.from(raw.subarray(1, 1 + v8));
  let a = 85;
  let b = 246;
  for (let i = 0; i < v8; i += 1) {
    const old = work[i];
    const previous = i & 1 ? a : b;
    if (i & 1) a = old; else b = old;
    const pop = i.toString(2).split('1').length - 1;
    work[i] = (-21 - pop + (previous ^ old)) & 255;
  }
  const hex = work.subarray(1, 33).toString('ascii');
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('hex') : null;
}

function decryptAppSpadeUrl(encoded, seedB64) {
  const raw = Buffer.from(String(encoded || '').trim(), 'base64');
  if (raw.length < 5 || raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00) return '';
  const cipherLen = Math.floor((raw.length - 4) / 16) * 16;
  if (!cipherLen) return '';
  const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const seed = Buffer.from(seedB64, 'base64');
  const h1 = crypto.createHash('sha512').update(seed).digest();
  const h2 = crypto.createHash('sha512').update(Buffer.concat([h1, constants])).digest();
  const decipher = crypto.createDecipheriv('aes-128-cbc', h2.subarray(0, 16), h2.subarray(16, 32));
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(raw.subarray(4, 4 + cipherLen)), decipher.final()]);
  if (out.length) {
    const pad = out[out.length - 1];
    if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);
  }
  while (out.length && out[out.length - 1] === 0) out = out.subarray(0, out.length - 1);
  return out.toString('utf8');
}

function isAllowedVodUrl(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && ALLOWED_VOD_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch (_) {
    return false;
  }
}

function parseBatchModelForVid(model, vid, qualityMode = 'fast') {
  if (!model || typeof model !== 'object' || !model.video_list || typeof model.video_list !== 'object') return null;
  const rows = Object.values(model.video_list).map((item) => {
    if (!item || (!item.main_url && !item.backup_url && !Array.isArray(item.backup_url_list))) return null;
    const codec = String(item.codec_type || item.video_meta?.codec_type || '').toLowerCase();
    const codecRank = ['h264', 'avc', 'avc1'].includes(codec) ? 0
      : ['hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'].includes(codec) ? 1
      : codec === 'bytevc2' ? 2 : 3;
    if (codecRank >= 3) return null;
    const meta = item.video_meta || {};
    const dims = [[item.vwidth, item.vheight], [item.width, item.height], [meta.vwidth, meta.vheight], [meta.width, meta.height]]
      .map((pair) => pair.map(Number))
      .find((pair) => pair.every((v) => Number.isFinite(v) && v > 0)) || [0, 0];
    const quality = String(item.quality_desc || item.definition || meta.definition || item.height || item.vheight || '').trim();
    const pixels = dims[0] && dims[1] ? Math.min(dims[0], dims[1]) : Number(quality.match(/\d+/)?.[0] || 0);
    if (codecRank === 2 && (dims[0] <= 0 || dims[1] <= 0 || !model.video_id || !(Number(model.video_duration) > 0))) return null;
    return { item, codec, codecRank, quality, pixels, width: dims[0], height: dims[1] };
  }).filter(Boolean);

  if (!rows.length) return null;
  const isFast = qualityMode === 'fast';
  rows.sort((a, b) => {
    if (isFast) {
      const aB2 = a.codecRank === 2 ? 1 : 0;
      const bB2 = b.codecRank === 2 ? 1 : 0;
      if (aB2 !== bB2) return aB2 - bB2;
      return b.pixels - a.pixels;
    }
    return b.pixels - a.pixels || a.codecRank - b.codecRank;
  });

  const bestPixels = rows[0].pixels;
  const selectedRows = !isFast && bestPixels > 0 ? rows.filter((r) => r.pixels === bestPixels) : rows;
  const variants = [];
  const seen = new Set();
  for (const row of selectedRows) {
    const spade = row.item.spade_a || row.item.encrypt_info?.spade_a;
    const encrypt = row.item.encrypt_info?.encrypt ?? row.item.encrypt;
    if (!spade && ![false, 0, '0', 'false'].includes(encrypt)) continue;
    const contentKey = spade ? deriveAppContentKeyHex(spade) : null;
    if (spade && !contentKey) continue;
    const candidates = [
      row.item.main_url,
      row.item.backup_url,
      ...(Array.isArray(row.item.backup_url_list) ? row.item.backup_url_list : []),
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate) continue;
      const mediaUrl = model.key_seed ? decryptAppSpadeUrl(candidate, model.key_seed) : cleanBatchMediaUrl(candidate);
      if (!isAllowedVodUrl(mediaUrl)) continue;
      const uniq = `${mediaUrl}:${contentKey || ''}`;
      if (seen.has(uniq)) continue;
      seen.add(uniq);
      variants.push({
        url: mediaUrl,
        contentKey,
        codec: row.codec === 'bytevc1' ? 'hevc' : row.codec,
        source: 'app',
        vid: String(vid),
        userAgent: APP_PLAYBACK_UA,
        quality: row.width && row.height ? `${Math.min(row.width, row.height)}p` : row.quality,
        width: row.width,
        height: row.height,
        ...(row.codec === 'bytevc2' ? { duration: Number(model.video_duration) || 0 } : {}),
      });
    }
  }
  return variants.length ? { ...variants[0], variants } : null;
}

/**
 * Batch-resolve up to 15 episodes in one multi_video_model/v1 call (~0.6s vs ~35s serial).
 * Returns Map<epNum, playInfo>; misses fall back gracefully to resolvePlayInfoSmart.
 */
async function resolveBatchPlayInfos(epItems, { qualityMode = 'fast', signal } = {}) {
  const results = new Map();
  if (!Array.isArray(epItems) || !epItems.length || signal?.aborted) return results;

  const cleanItems = epItems.filter((x) => x && /^\d{1,30}$/.test(String(x.epData?.vid || '')));
  if (!cleanItems.length) return results;

  try {
    const identity = await getPlaybackDevice(appRequestJson);
    if (signal?.aborted) return results;
    const vids = cleanItems.map((x) => String(x.epData.vid));
    const payload = JSON.stringify({
      biz_param: {
        detail_page_version: 0, device_level: 3, disable_digg_stat: false,
        need_all_video_definition: true, need_mp4_align: false,
        use_os_player: false, use_server_dns: false, video_platform: 1024,
      },
      mixed_video_id_map: { '1004': vids },
    });
    const body = gzipSync(Buffer.from(payload));

    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) return results;
      const rt = Date.now();
      const ts = Math.floor(rt / 1000);
      const query = encodePythonQuery({ ...APP_PLAYBACK_DEVICE, ...identity, ts: String(ts), _rticket: String(rt) });
      const sig = signPlayer({ query, body, ts });
      try {
        res = await appRequestJson(`${APP_VIDEO_API}?${query}`, {
          method: 'POST',
          headers: {
            'User-Agent': APP_PLAYBACK_UA,
            Accept: 'application/json; charset=utf-8,application/x-protobuf',
            'x-ss-req-ticket': sig['x-ss-req-ticket'],
            'sdk-version': '2',
            'x-xs-from-web': '0',
            'passport-sdk-version': '5051452',
            'x-ss-dp': String(APP_PLAYBACK_DEVICE.aid),
            'x-khronos': sig['x-khronos'],
            'x-ladon': sig['x-ladon'],
            'x-argus': sig['x-argus'],
            'x-tt-dt': '',
            'x-tt-store-region': 'cn',
            'x-tt-store-region-src': 'did',
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Encoding': 'gzip',
            'x-ss-stub': sig['x-ss-stub'],
            Connection: 'close',
          },
          data: body,
        }, Date.now() + 9000, signal);
        break;
      } catch (err) {
        if (signal?.aborted || err.code === 'ERR_CANCELED') return results;
        if (attempt < 2 && ['EMPTY_RESPONSE', 'ETIMEDOUT', 'TIMEOUT', 'NETWORK_ERROR'].includes(err.code)) {
          await sleep(250 * (attempt + 1), signal);
          continue;
        }
        return results;
      }
    }

    if (Number(res?.Code || res?.code || 0) !== 0) return results;
    const entries = res?.data?.video_model_data ?? res?.data ?? {};
    for (const item of cleanItems) {
      const vid = String(item.epData.vid);
      const entry = entries[vid];
      if (!entry || !entry.video_model) continue;
      let model = entry.video_model;
      if (typeof model === 'string') {
        try { model = JSON.parse(model); } catch (_) { continue; }
      }
      const parsed = parseBatchModelForVid(model, vid, qualityMode);
      if (parsed) results.set(item.epNum, parsed);
    }
  } catch (_) {}
  return results;
}

/**
 * Smart Play-URL resolver: tries fast App API first (skipping slow dead web 404 checks),
 * with retry backoff and web/legacy fallback only if App fails.
 */
async function resolvePlayInfoSmart(epData, seriesId, { qualityMode = '1080p', signal, onLog } = {}) {
  const vid = String(epData.vid || '');
  const epNum = epData.vid_index;
  const src = (epData.source && epData.source !== 'hongguo') ? epData.source : sources.detectSourceFromId(seriesId || vid);
  if (epData.locked) {
    throw new Error(`ភាគ ${epNum} ជាប់សោ VIP លើ ${src.toUpperCase()} — ទាញបានតែភាគឥតគិតថ្លៃ`);
  }
  if (src !== 'hongguo') {
    const play = await sources.fetchPlayUrlUnified(vid, seriesId, { signal });
    if (signal?.aborted) throw new Error('CANCELLED');
    if (play && play.url) return play;
    throw new Error(play?.error || `មិនអាចទាញ Link ភាគ ${epNum} ពី ${src} បានទេ`);
  }
  const isFastHybrid = qualityMode === 'fast';
  // Requesting 720p + allowLowerQuality returns ALL available resolutions (720p, 1080p, 540p...) in one call!
  const appOpts = isFastHybrid
    ? { quality: '720p', allowLowerQuality: true, signal }
    : { quality: 'auto', signal };

  // 1. Fetch straight from App API with retry on EMPTY_RESPONSE / transient failures
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const play = await fetchAppPlayUrl(vid, appOpts);
      if (play && play.url) return play;
    } catch (err) {
      if (signal?.aborted || err.code === 'ERR_CANCELED') throw new Error('CANCELLED');
      lastError = err;
      const msg = String(err.message || '');
      const isRetryable = err.code === 'EMPTY_RESPONSE' || err.code === 'ETIMEDOUT' || err.code === 'TIMEOUT' ||
        err.code === 'NETWORK_ERROR' || /空响应|超时|timeout|ECONNRESET/i.test(msg);
      if (attempt < 3 && isRetryable) {
        if (onLog) onLog(`🔄 ភាគ ${epNum}: Server ឆ្លើយតបយឺត (${err.code || 'Retry'}) — សាកល្បងលើកទី ${attempt + 1}/3...`);
        await sleep(600 * attempt, signal);
        continue;
      }
      break;
    }
  }

  // 2. Fallback to web (only if marked web_available) or unified legacy resolver
  if (!signal?.aborted && epData.web_available === true) {
    try {
      const webPlay = await fetchPlayUrlFromWeb(vid, seriesId, null, signal);
      if (webPlay && webPlay.url) return webPlay;
    } catch (_) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  if (!signal?.aborted) {
    try {
      const fallback = await fetchPlayUrlSingle(vid, seriesId, { quality: 'auto', signal });
      if (fallback && fallback.url) return fallback;
      if (fallback && fallback.error && !lastError) {
        lastError = new Error(fallback.error);
      }
    } catch (err) {
      if (!lastError) lastError = err;
    }
  }

  throw lastError || new Error('មិនអាចទាញយក Link វីដេអូសម្រាប់ភាគនេះបានទេ');
}

/**
 * Download media URL to local disk via Axios streaming with real-time byte tracking & Content-Length check.
 */
async function downloadUrlStream(variant, destPath, { signal, onBytesProgress } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let headerTimer = null;
  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      controller.abort(new Error('CDN stream stalled'));
    }, 10000);
  };

  try {
    // Fail fast on dead HongGuo CDN edges (6s), allow 18s for cross-region sources (Xifan/Hema/DramaBox)
    const isHongguoEdge = !variant.source || ['hongguo', 'app', 'web'].includes(variant.source);
    const headerMs = isHongguoEdge ? 6000 : 18000;
    headerTimer = setTimeout(() => {
      controller.abort(new Error('CDN response header timeout'));
    }, headerMs);
    const res = await axios.get(variant.url, {
      responseType: 'stream',
      timeout: isHongguoEdge ? 10000 : 22000,
      maxRedirects: 5,
      signal: controller.signal,
      httpAgent,
      httpsAgent,
      headers: {
        'User-Agent': variant.userAgent || WEB_UA,
        ...(variant.referer ? { Referer: variant.referer } : {}),
        'Accept': '*/*',
        'Connection': 'keep-alive',
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    clearTimeout(headerTimer);
    headerTimer = null;

    const totalLength = Number(res.headers['content-length']) || 0;
    const contentType = String(res.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      res.data.destroy();
      throw new Error(`CDN បានត្រឡប់ ${contentType} ជំនួសឱ្យវីដេអូ`);
    }

    let received = 0;
    let lastDeltaReported = 0;
    let lastEmitTime = 0;

    resetStall();
    const writer = fs.createWriteStream(destPath);
    res.data.on('data', (chunk) => {
      resetStall();
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmitTime >= 250) {
        const delta = received - lastDeltaReported;
        lastDeltaReported = received;
        lastEmitTime = now;
        const pct = totalLength > 0 ? Math.min(99, Math.round((received / totalLength) * 100)) : 35;
        onBytesProgress?.(delta, pct, received, totalLength);
      }
    });

    await pipeline(res.data, writer);
    if (received > lastDeltaReported) {
      onBytesProgress?.(received - lastDeltaReported, 100, received, totalLength);
    }

    if (totalLength > 0 && received !== totalLength) {
      throw new Error(`ឯកសារទាញយកមិនគ្រប់ទំហំ (${received}/${totalLength} bytes)`);
    }
    if (received < MIN_VALID_MP4_BYTES) {
      throw new Error(`ទំហំឯកសារតូចពេក (${received} bytes)`);
    }
    return received;
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fallback download using curl.exe with proper headers and speed-limit stall protection.
 */
function downloadWithCurl(variant, destPath, { signal, activeChildren } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const args = [
      '-s', '-S', '-L', '-f',
      '--connect-timeout', '10',
      '--speed-limit', '10240',
      '--speed-time', '15',
      '-m', '90',
      '--retry', '1',
      ...(variant.userAgent ? ['-A', variant.userAgent] : []),
      ...(variant.referer ? ['-e', variant.referer] : []),
      variant.url,
      '-o', destPath,
    ];
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    activeChildren?.add(child);
    let errText = '';
    child.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-500); });
    const onAbort = () => {
      ytdlp.killProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('CANCELLED'));
      if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size >= MIN_VALID_MP4_BYTES) {
        return resolve(fs.statSync(destPath).size);
      }
      reject(new Error(`curl code ${code}: ${errText.trim() || 'download failed'}`));
    });
    child.on('error', (err) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/**
 * Multi-connection (16x) MP4 download using persistent aria2c RPC daemon (zero process spawn overhead),
 * falling back to direct aria2c.exe spawn if RPC is unavailable.
 */
async function downloadWithAria2(variant, destPath, { signal, activeChildren, onBytesProgress, preferRpc = true } = {}) {
  if (signal?.aborted) throw new Error('CANCELLED');
  if (!ytdlp.isAria2Available()) throw new Error('aria2c មិនមាននៅក្នុង bin/');

  if (preferRpc) {
    try {
      return await aria2Rpc.downloadViaRpc(variant, destPath, {
        signal,
        onBytesProgress,
        validateFileFn: isValidMp4File,
      });
    } catch (err) {
      if (signal?.aborted || err.message === 'CANCELLED') throw new Error('CANCELLED');
      // If upstream returned a clear download error code from aria2, bubble up to HTTP fallback directly;
      // only spawn standalone aria2c if the RPC daemon itself failed to start or dropped locally.
      if (/^aria2 RPC err \d+:/i.test(err.message)) {
        throw err;
      }
    }
  }
  return downloadWithAria2Spawn(variant, destPath, { signal, activeChildren, onBytesProgress });
}

function downloadWithAria2Spawn(variant, destPath, { signal, activeChildren, onBytesProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    if (!ytdlp.isAria2Available()) return reject(new Error('aria2c មិនមាននៅក្នុង bin/'));

    const destDir = path.dirname(destPath);
    const destName = path.basename(destPath);
    const ariaControlPath = `${destPath}.aria2`;
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}

    const cleanupTemp = (removeDest = false) => {
      try { if (fs.existsSync(ariaControlPath)) fs.unlinkSync(ariaControlPath); } catch (_) {}
      if (removeDest) {
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
      }
    };

    const args = [
      '-x', '16',
      '-s', '16',
      '-k', '1M',
      '--file-allocation=none',
      '--allow-overwrite=true',
      '--auto-file-renaming=false',
      '--continue=false',
      '--no-conf',
      '--check-certificate=false',
      '--connect-timeout=12',
      '--timeout=25',
      '--max-tries=2',
      '--retry-wait=1',
      '--summary-interval=1',
      '--user-agent', variant.userAgent || WEB_UA,
      ...(variant.referer ? ['--referer', variant.referer] : []),
      '-d', destDir,
      '-o', destName,
      variant.url,
    ];

    const child = spawn(ytdlp.ARIA2C_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren?.add(child);

    let outBuf = '';
    let errText = '';
    let lastBytes = 0;
    let totalReported = 0;
    let settled = false;

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      // aria2c progress format: [#194fe9 1.5MiB/7.1MiB(22%) CN:8 DL:260KiB ETA:21s]
      const m = /^\[#[0-9a-f]+\s+([\d.]+)([KMG]?i?B)\/([\d.]+)([KMG]?i?B)\((\d+)%\)/.exec(line);
      if (!m) return;
      const curBytes = Math.round(ytdlp.parseSizeToBytes(m[1], m[2]));
      const totBytes = Math.round(ytdlp.parseSizeToBytes(m[3], m[4]));
      const pct = Math.min(99, Math.max(0, parseInt(m[5], 10) || 0));
      const delta = Math.max(0, curBytes - lastBytes);
      if (curBytes > lastBytes) lastBytes = curBytes;
      if (delta > 0 || pct > 0) {
        totalReported += delta;
        onBytesProgress?.(delta, pct, curBytes, totBytes);
      }
    };

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      const parts = outBuf.split(/[\r\n]+/);
      outBuf = /[\r\n]$/.test(outBuf) ? '' : (parts.pop() || '');
      for (const p of parts) handleLine(p);
    });
    child.stderr.on('data', (chunk) => {
      errText = (errText + chunk.toString()).slice(-500);
    });

    const onAbort = () => {
      ytdlp.killProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (outBuf) handleLine(outBuf);

      if (signal?.aborted) {
        cleanupTemp(true);
        return reject(new Error('CANCELLED'));
      }
      cleanupTemp(false);
      if (code === 0 && isValidMp4File(destPath)) {
        const finalSize = fs.statSync(destPath).size;
        const remainder = Math.max(0, finalSize - totalReported);
        if (remainder > 0 || totalReported === 0) {
          onBytesProgress?.(remainder, 100, finalSize, finalSize);
        }
        return resolve(finalSize);
      }
      cleanupTemp(true);
      reject(new Error(`aria2c code ${code}: ${errText.trim() || 'download failed'}`));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      cleanupTemp(true);
      reject(err);
    });
  });
}

/**
 * Multi-threaded HLS (.m3u8) downloader + MP4 muxer via N_m3u8DL-RE.exe and bundled ffmpeg.exe.
 */
async function downloadHlsWithNm3u8dl(variant, destMp4, { signal, activeChildren, onBytesProgress } = {}) {
  if (signal?.aborted) throw new Error('CANCELLED');
  if (!ytdlp.isNm3u8dlAvailable()) throw new Error('N_m3u8DL-RE.exe មិនមាននៅក្នុង bin/');

  const destDir = path.dirname(destMp4);
  fs.mkdirSync(destDir, { recursive: true });
  const workDir = path.join(destDir, `.nm3u8_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(workDir, { recursive: true });

  const cleanupWorkDir = () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    const outFile = await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('CANCELLED'));

      const args = [
        variant.url,
        '--tmp-dir', workDir,
        '--save-dir', workDir,
        '--save-name', 'output',
        '--thread-count', '16',
        '--download-retry-count', '3',
        '--http-request-timeout', '30',
        '--auto-select',
        '--concurrent-download',
        '--del-after-done',
        '--no-ansi-color',
        '--no-log',
        '--write-meta-json', 'false',
        '--disable-update-check',
        '-M', 'format=mp4',
        '-H', `User-Agent: ${variant.userAgent || WEB_UA}`,
      ];
      if (variant.referer) {
        args.push('-H', `Referer: ${variant.referer}`);
      }
      if (fs.existsSync(FFMPEG_EXE)) {
        args.push('--ffmpeg-binary-path', FFMPEG_EXE);
      }

      const child = spawn(ytdlp.NM3U8DL_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChildren?.add(child);

      let outBuf = '';
      let errText = '';
      let lastBytes = 0;
      let totalReported = 0;
      let settled = false;

      const handleLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        // Example: 2/22 9.09% 2.99MB/32.93MB309.25KBps00:01:22
        const m = /(\d+)\/(\d+)\s+([\d.]+)%\s+([\d.]+)([KMG]?i?B)\/(?:([\d.]+)([KMG]?i?B))?/.exec(line);
        if (!m) return;
        const pct = Math.min(92, Math.max(12, Math.round(parseFloat(m[3]) || 0)));
        const curBytes = Math.round(ytdlp.parseSizeToBytes(m[4], m[5]));
        const totBytes = m[6] ? Math.round(ytdlp.parseSizeToBytes(m[6], m[7])) : 0;
        let delta = 0;
        if (curBytes >= lastBytes) {
          delta = curBytes - lastBytes;
        } else {
          // Concurrent track switched or restarted
          delta = curBytes;
        }
        lastBytes = curBytes;
        if (delta > 0 || pct > 0) {
          totalReported += delta;
          onBytesProgress?.(delta, pct, curBytes, totBytes);
        }
      };

      child.stdout.on('data', (chunk) => {
        outBuf += chunk.toString();
        const parts = outBuf.split(/[\r\n]+/);
        outBuf = /[\r\n]$/.test(outBuf) ? '' : (parts.pop() || '');
        for (const p of parts) handleLine(p);
      });
      child.stderr.on('data', (chunk) => {
        errText = (errText + chunk.toString()).slice(-500);
      });

      const onAbort = () => {
        ytdlp.killProcessTree(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        activeChildren?.delete(child);
        signal?.removeEventListener('abort', onAbort);
        if (outBuf) handleLine(outBuf);

        if (signal?.aborted) return reject(new Error('CANCELLED'));
        if (code !== 0) {
          return reject(new Error(`N_m3u8DL-RE code ${code}: ${errText.trim() || 'HLS failed'}`));
        }
        const preferred = path.join(workDir, 'output.mp4');
        if (isValidMp4File(preferred)) {
          return resolve({ file: preferred, totalReported });
        }
        try {
          const candidates = fs.readdirSync(workDir)
            .filter((f) => /\.(mp4|mkv|ts)$/i.test(f))
            .map((f) => path.join(workDir, f))
            .filter((p) => isValidMp4File(p))
            .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
          if (candidates.length > 0) {
            return resolve({ file: candidates[0], totalReported });
          }
        } catch (_) {}
        reject(new Error('N_m3u8DL-RE មិនបានបង្កើតឯកសារ MP4 ត្រឹមត្រូវទេ'));
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        activeChildren?.delete(child);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });

    if (signal?.aborted) throw new Error('CANCELLED');
    if (fs.existsSync(destMp4)) {
      try { fs.unlinkSync(destMp4); } catch (_) {}
    }
    try {
      await fsp.rename(outFile.file, destMp4);
    } catch (_) {
      await fsp.copyFile(outFile.file, destMp4);
    }
    if (!isValidMp4File(destMp4)) {
      throw new Error('ឯកសារ N_m3u8DL-RE MP4 មិនត្រឹមត្រូវ');
    }
    const finalSize = fs.statSync(destMp4).size;
    const remainder = Math.max(0, finalSize - outFile.totalReported);
    if (remainder > 0 || outFile.totalReported === 0) {
      onBytesProgress?.(remainder, 92, finalSize, finalSize);
    }
    return finalSize;
  } finally {
    cleanupWorkDir();
  }
}

async function downloadHlsToMp4(variant, destMp4, { signal, activeChildren, onBytesProgress } = {}) {
  if (ytdlp.isNm3u8dlAvailable()) {
    try {
      return await downloadHlsWithNm3u8dl(variant, destMp4, { signal, activeChildren, onBytesProgress });
    } catch (err) {
      if (signal?.aborted || err.message === 'CANCELLED') throw new Error('CANCELLED');
      try { if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4); } catch (_) {}
    }
  }

  if (ytdlp.isAvailable()) {
    try {
      await ytdlp.downloadHlsStream({
        url: variant.url,
        outputFile: destMp4,
        referer: variant.referer || '',
        userAgent: variant.userAgent || '',
        concurrentFragments: 8,
        signal,
        activeChildren,
        onProgress: (p) => {
          const dlPct = Math.min(92, Math.max(12, Math.round(p.itemPct || 0)));
          if (p.bytesDelta > 0) onBytesProgress?.(p.bytesDelta, dlPct, p.receivedBytes || 0, p.totalBytes || 0);
        },
      });
      if (isValidMp4File(destMp4)) {
        return fs.statSync(destMp4).size;
      }
    } catch (err) {
      if (signal?.aborted || err.message === 'CANCELLED') throw new Error('CANCELLED');
      try { if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4); } catch (_) {}
    }
  }

  let prevBytes = 0;
  await remuxHls({
    url: variant.url,
    output: destMp4,
    ffmpeg: FFMPEG_EXE,
    signal,
    headers: {
      ...(variant.userAgent ? { 'User-Agent': variant.userAgent } : {}),
      ...(variant.referer ? { Referer: variant.referer } : {}),
    },
    onProgress: (totalBytes) => {
      const delta = Math.max(0, totalBytes - prevBytes);
      prevBytes = Math.max(prevBytes, totalBytes);
      if (delta > 0) onBytesProgress?.(delta, Math.min(92, 15 + Math.round(totalBytes / (500 * 1024))), totalBytes, 0);
    },
  });
  if (!isValidMp4File(destMp4)) {
    throw new Error('ឯកសារ HLS បំប្លែងមិនត្រឹមត្រូវ ឬ 0 Bytes');
  }
  return fs.statSync(destMp4).size;
}

/**
 * Probe video duration (seconds) via ffprobe for accurate transcode % progress.
 */
function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFPROBE_EXE)) return resolve(0);
    const child = spawn(FFPROBE_EXE, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => {
      const val = parseFloat(out.trim());
      resolve(Number.isFinite(val) && val > 0 ? val : 0);
    });
    child.on('error', () => resolve(0));
  });
}

function runFfmpegCommand(executable, args, { signal, activeChildren, durationSec = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren?.add(child);
    let stderrBuf = '';
    let stdoutBuf = '';
    let detectedDuration = durationSec;

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && detectedDuration > 0) {
          const sec = Number(m[1]) / 1e6;
          const pct = Math.min(99, Math.max(1, Math.round((sec / detectedDuration) * 100)));
          onProgress?.(pct, sec);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const txt = chunk.toString();
      stderrBuf = (stderrBuf + txt).slice(-2000);
      if (!detectedDuration) {
        const dm = txt.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (dm) {
          detectedDuration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + parseFloat(dm[3]);
        }
      }
    });

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch (_) {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('CANCELLED'));
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg/LibreMpeg exited (${code}): ${stderrBuf.trim().slice(-200)}`));
    });
    child.on('error', (err) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/**
 * Simple Async Semaphore to limit concurrent CPU-heavy ByteVC2 transcoding.
 */
function createSemaphore(maxConcurrent) {
  let active = 0;
  const queue = [];
  return async function run(fn, signal) {
    if (signal?.aborted) throw new Error('CANCELLED');
    if (active >= maxConcurrent) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
          reject(new Error('CANCELLED'));
        };
        const entry = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        const next = queue.shift();
        next.resolve();
      }
    }
  };
}

const LIBREMPEG_ENCODE_ARGS = [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', '-movflags', '+faststart',
  '-progress', 'pipe:1', '-nostats', '-f', 'mp4',
];

/**
 * Decrypt or transcode downloaded tempEnc into valid MP4 at tempOutMp4.
 */
async function processDownloadedEpisode(variant, tempEnc, tempOutMp4, { signal, activeChildren, bytevc2Sem, onPhaseProgress } = {}) {
  if (signal?.aborted) throw new Error('CANCELLED');

  // Case 1: ByteVC2 proprietary stream -> must use librempeg.exe to transcode to H.264
  if (variant.codec === 'bytevc2') {
    if (!fs.existsSync(LIBREMPEG_EXE)) {
      throw new Error('រកមិនឃើញ librempeg.exe សម្រាប់បំប្លែង ByteVC2');
    }
    onPhaseProgress?.('queued_transcode', 55);
    await bytevc2Sem(async () => {
      if (signal?.aborted) throw new Error('CANCELLED');
      const dur = variant.duration || (await probeDurationSec(tempEnc)) || 45;
      onPhaseProgress?.('transcoding', 58);
      const args = [
        '-y', '-hide_banner', '-loglevel', 'warning', '-xerror',
        '-protocol_whitelist', 'file,pipe',
        '-threads:v', '4',
        ...(variant.contentKey ? ['-decryption_key', variant.contentKey] : []),
        '-i', tempEnc,
        '-map', '0:v:0', '-map', '0:a?',
        ...LIBREMPEG_ENCODE_ARGS,
        tempOutMp4,
      ];
      await runFfmpegCommand(LIBREMPEG_EXE, args, {
        signal,
        activeChildren,
        durationSec: dur,
        onProgress: (pct) => {
          onPhaseProgress?.('transcoding', 58 + Math.round(pct * 0.41));
        },
      });
    }, signal);
    return;
  }

  // Case 2: CENC contentKey with standard H.264 / HEVC -> fast zero-reencode stream copy!
  if (variant.contentKey) {
    onPhaseProgress?.('decrypting', 75);
    const copyArgs = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-decryption_key', variant.contentKey,
      '-i', tempEnc,
      '-map', '0:v:0', '-map', '0:a?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4', tempOutMp4,
    ];
    try {
      await runFfmpegCommand(FFMPEG_EXE, copyArgs, { signal, activeChildren });
      if (isValidMp4File(tempOutMp4)) return;
    } catch (err) {
      if (signal?.aborted || err.message === 'CANCELLED') throw err;
      // Clean failed partial output before fallback transcode
      try { if (fs.existsSync(tempOutMp4)) fs.unlinkSync(tempOutMp4); } catch (_) {}
      // Auto-fallback to librempeg transcode in case metadata mislabeled ByteVC2!
      if (fs.existsSync(LIBREMPEG_EXE)) {
        onPhaseProgress?.('transcoding', 78);
        await bytevc2Sem(async () => {
          const dur = variant.duration || 45;
          const fallbackArgs = [
            '-y', '-hide_banner', '-loglevel', 'warning', '-xerror',
            '-threads:v', '4',
            '-decryption_key', variant.contentKey,
            '-i', tempEnc,
            '-map', '0:v:0', '-map', '0:a?',
            ...LIBREMPEG_ENCODE_ARGS,
            tempOutMp4,
          ];
          await runFfmpegCommand(LIBREMPEG_EXE, fallbackArgs, {
            signal,
            activeChildren,
            durationSec: dur,
            onProgress: (pct) => onPhaseProgress?.('transcoding', 78 + Math.round(pct * 0.21)),
          });
        }, signal);
        return;
      }
      throw err;
    }
    return;
  }

  // Case 3: Legacy spadeA encryption
  if (variant.spadeA) {
    onPhaseProgress?.('decrypting', 80);
    const key = deriveKey(variant.spadeA);
    if (!key) throw new Error('មិនអាចបំបែកសោ spadeA បានទេ');
    decryptMp4File(tempEnc, tempOutMp4, key);
    return;
  }

  // Case 4: Unencrypted MP4 (web / direct)
  onPhaseProgress?.('verifying', 92);
  if (!isValidMp4File(tempEnc)) {
    throw new Error('ឯកសារវីដេអូមិនត្រឹមត្រូវ (Corrupted / Not MP4)');
  }
  await fsp.rename(tempEnc, tempOutMp4);
}

function probeVideoSignature(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFPROBE_EXE)) return resolve('unknown');
    const child = spawn(FFPROBE_EXE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'csv=p=0:s=x',
      filePath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => resolve(out.trim() || 'unknown'));
    child.on('error', () => resolve('unknown'));
  });
}

/**
 * Pick the dominant resolution from ffprobe signatures (breaking ties by highest pixel area)
 * so one low-res episode never downgrades an entire 1080p drama during merge.
 */
function pickDominantResolution(validSigs) {
  const counts = new Map();
  for (const sig of validSigs) {
    const m = /^[^x]+x(\d+)x(\d+)$/.exec(sig);
    if (!m) continue;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w > 0 && h > 0) {
      const key = `${w}x${h}`;
      const prev = counts.get(key);
      counts.set(key, { w, h, count: (prev ? prev.count : 0) + 1 });
    }
  }
  if (!counts.size) return { w: 1080, h: 1920 };
  const best = [...counts.values()].sort((a, b) => (b.count - a.count) || ((b.w * b.h) - (a.w * a.h)))[0];
  return {
    w: best.w - (best.w % 2),
    h: best.h - (best.h % 2),
  };
}

let cachedGpuEncoderPromise = null;

/**
 * Probe and smoke-test GPU H.264 encoder (NVENC / QSV / AMF) once per process, returning encoder name or null.
 */
function detectGpuH264Encoder() {
  if (cachedGpuEncoderPromise) return cachedGpuEncoderPromise;
  cachedGpuEncoderPromise = (async () => {
    if (!fs.existsSync(FFMPEG_EXE)) return null;
    const encodersOut = await new Promise((resolve) => {
      const child = spawn(FFMPEG_EXE, ['-hide_banner', '-encoders'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => { ytdlp.killProcessTree(child); resolve(''); }, 3000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => { clearTimeout(t); resolve(out); });
      child.on('error', () => { clearTimeout(t); resolve(''); });
    });
    const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf'].filter((name) => encodersOut.includes(name));
    for (const enc of candidates) {
      const ok = await new Promise((resolve) => {
        const child = spawn(FFMPEG_EXE, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=black:s=128x128:d=0.1',
          '-frames:v', '1', '-c:v', enc, '-f', 'null', '-',
        ], { windowsHide: true, stdio: 'ignore' });
        const t = setTimeout(() => { ytdlp.killProcessTree(child); resolve(false); }, 5000);
        child.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
        child.on('error', () => { clearTimeout(t); resolve(false); });
      });
      if (ok) return enc;
    }
    return null;
  })();
  return cachedGpuEncoderPromise;
}

function buildNormalizeEncodeArgs(src, dst, targetW, targetH, gpuEncoder) {
  let videoCodecArgs;
  if (gpuEncoder === 'h264_nvenc') {
    videoCodecArgs = ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '23', '-pix_fmt', 'yuv420p'];
  } else if (gpuEncoder === 'h264_qsv') {
    videoCodecArgs = ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'yuv420p'];
  } else if (gpuEncoder === 'h264_amf') {
    videoCodecArgs = ['-c:v', 'h264_amf', '-quality', 'speed', '-pix_fmt', 'yuv420p'];
  } else {
    videoCodecArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p'];
  }
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-vf', `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    ...videoCodecArgs,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    dst,
  ];
}

/**
 * Merge downloaded episodes cleanly in strict numeric episode order.
 * Auto-detects mixed codecs/resolutions (e.g. HEVC + H.264 from ByteVC2) so merged MP4 always plays smoothly.
 */
async function mergeEpisodesToMovie(outputDir, cleanTitle, fileEntries, { onProgress, signal, activeChildren, outputLabel = '' } = {}) {
  if (!fs.existsSync(FFMPEG_EXE)) {
    throw new Error('រកមិនឃើញ ffmpeg.exe សម្រាប់ផ្គុំវីដេអូ');
  }
  const sorted = [...fileEntries]
    .filter(item => item.file && isValidMp4File(item.file))
    .sort((a, b) => a.epNum - b.epNum);

  if (sorted.length < 2) {
    throw new Error('ត្រូវការយ៉ាងតិច ២ ភាគដើម្បីផ្គុំជា Full Movie');
  }

  const firstEp = sorted[0].epNum;
  const lastEp = sorted[sorted.length - 1].epNum;
  onProgress?.(88, `🔍 កំពុងពិនិត្យស្តង់ដារវីដេអូ ${sorted.length} ភាគ (EP${firstEp} → EP${lastEp}) មុនពេលផ្គុំ...`);

  // Probe codecs/resolutions in small parallel wave
  const signatures = new Array(sorted.length);
  for (let i = 0; i < sorted.length; i += 8) {
    if (signal?.aborted) throw new Error('CANCELLED');
    const slice = sorted.slice(i, i + 8);
    const results = await Promise.all(slice.map(item => probeVideoSignature(item.file)));
    results.forEach((sig, j) => { signatures[i + j] = sig; });
  }

  const validSigs = signatures.filter(s => s && s !== 'unknown');
  const uniqueSigs = new Set(validSigs);
  const concatInputs = [];
  const tempNormalized = [];

  try {
    if (uniqueSigs.size > 1) {
      const { w: targetW, h: targetH } = pickDominantResolution(validSigs);
      const targetSig = `h264x${targetW}x${targetH}`;

      const needNorm = [];
      for (let i = 0; i < sorted.length; i++) {
        if (signatures[i] === targetSig) {
          concatInputs.push(sorted[i].file);
        } else {
          const normFile = path.join(outputDir, `temp_norm_${sorted[i].epNum}_${Date.now()}.mp4`);
          tempNormalized.push(normFile);
          concatInputs.push(normFile);
          needNorm.push({ src: sorted[i].file, dst: normFile, epNum: sorted[i].epNum });
        }
      }

      if (needNorm.length > 0) {
        const gpuEncoder = await detectGpuH264Encoder();
        const encTag = gpuEncoder ? `GPU ${gpuEncoder}` : 'CPU x264';
        onProgress?.(89, `⚙️ រកឃើញវីដេអូផ្សេងខ្នាតគ្នា — កំពុងសម្រួល ${needNorm.length} ភាគ (${targetW}x${targetH} • ${encTag})...`);
        let doneNorm = 0;
        const cpuCount = require('os').cpus().length || 4;
        const normConc = gpuEncoder ? 3 : Math.min(4, Math.max(2, Math.floor(cpuCount / 2)));
        for (let i = 0; i < needNorm.length; i += normConc) {
          if (signal?.aborted) throw new Error('CANCELLED');
          const batch = needNorm.slice(i, i + normConc);
          await Promise.all(batch.map(async (item) => {
            try {
              await runFfmpegCommand(FFMPEG_EXE, buildNormalizeEncodeArgs(item.src, item.dst, targetW, targetH, gpuEncoder), { signal, activeChildren });
            } catch (err) {
              if (!gpuEncoder || signal?.aborted || err.message === 'CANCELLED') throw err;
              // Seamless CPU fallback if a specific clip fails hardware encode
              await runFfmpegCommand(FFMPEG_EXE, buildNormalizeEncodeArgs(item.src, item.dst, targetW, targetH, null), { signal, activeChildren });
            }
            doneNorm++;
            const pct = 89 + Math.round((doneNorm / needNorm.length) * 7);
            onProgress?.(pct, `⚙️ សម្រួលស្តង់ដារវីដេអូសម្រាប់ផ្គុំ (${doneNorm}/${needNorm.length} ភាគ • ${encTag})...`);
          }));
        }
      }
    } else {
      for (const item of sorted) concatInputs.push(item.file);
    }

    const concatListFile = path.join(outputDir, `concat_list_${Date.now()}.txt`);
    const mergedTemp = path.join(outputDir, `temp_merged_${Date.now()}.mp4`);
    const mergedOutput = resolveMergedMoviePath(outputDir, cleanTitle, outputLabel);
    const mergedDir = path.dirname(mergedOutput);
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    tempNormalized.push(concatListFile, mergedTemp);

    const fileListContent = concatInputs
      .map(f => `file '${f.replace(/'/g, "'\\''").replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatListFile, fileListContent, 'utf8');

    onProgress?.(97, `🎞️ កំពុងផ្គុំ ${sorted.length} ភាគចូលគ្នាតាមលំដាប់ (EP${firstEp} → EP${lastEp})...`);
    await runFfmpegCommand(FFMPEG_EXE, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', concatListFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      mergedTemp,
    ], { signal, activeChildren });

    if (!isValidMp4File(mergedTemp)) {
      throw new Error('ការផ្គុំ Full Movie បរាជ័យ (ឯកសារចុងក្រោយខូច)');
    }
    if (fs.existsSync(mergedOutput)) {
      try { fs.unlinkSync(mergedOutput); } catch (_) {}
    }
    await fsp.rename(mergedTemp, mergedOutput);
    const sizeMb = (fs.statSync(mergedOutput).size / (1024 * 1024)).toFixed(1);
    onProgress?.(100, `🎬 ផ្គុំតាមលំដាប់រួចរាល់: ${path.basename(mergedOutput)} (${sizeMb} MB, ${sorted.length} ភាគ)!`);
    return { path: mergedOutput, fileName: path.basename(mergedOutput), sizeMb, count: sorted.length, mergedEps: sorted.map((x) => x.epNum) };
  } finally {
    for (const f of tempNormalized) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
}

module.exports = {
  FFMPEG_EXE,
  LIBREMPEG_EXE,
  FFPROBE_EXE,
  MIN_VALID_MP4_BYTES,
  sleep,
  sanitizeTitle,
  resolveEpisodeFileName,
  resolveMergedMoviePath,
  listMergedMovieFiles,
  findMergedMovieFile,
  hasMergedMovie,
  parseEpisodeNumberFromFileName,
  organizeDramaFolder,
  syncEpisodeFileTimestamps,
  findExistingEpisodeFile,
  findMediaFileForPlayback,
  isValidMp4File,
  isPlayableMediaFile,
  scanAndCleanDramaFolder,
  removeBrokenMp4Files,
  resolveSafeSubdir,
  readDramaMeta,
  saveDramaMeta,
  listDramaEpisodeFiles,
  scanDramaLibrary,
  extractVariants,
  resolveBatchPlayInfos,
  resolvePlayInfoSmart,
  downloadUrlStream,
  downloadHlsToMp4,
  downloadWithAria2,
  downloadWithCurl,
  isAria2Available: ytdlp.isAria2Available,
  isNm3u8dlAvailable: ytdlp.isNm3u8dlAvailable,
  getAria2Version: ytdlp.getAria2Version,
  getNm3u8dlVersion: ytdlp.getNm3u8dlVersion,
  ensureAria2Daemon: aria2Rpc.ensureDaemon,
  shutdownAria2Daemon: aria2Rpc.shutdownDaemon,
  getAria2RpcStatus: aria2Rpc.getDaemonStatus,
  detectGpuH264Encoder,
  processDownloadedEpisode,
  mergeEpisodesToMovie,
  createSemaphore,
};
