const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function resolveBinDir() {
  const candidates = [
    process.env.EZA_BIN_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : '',
    path.join(__dirname, '..', 'bin')
  ].filter(Boolean);
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'ffmpeg.exe')) ||
      fs.existsSync(path.join(dir, 'yt-dlp.exe')) ||
      fs.existsSync(path.join(dir, 'aria2c.exe'))
    ) {
      return dir;
    }
  }
  return path.join(__dirname, '..', 'bin');
}

const BIN_DIR = resolveBinDir();
const YTDLP_EXE = path.join(BIN_DIR, 'yt-dlp.exe');
const ARIA2C_EXE = path.join(BIN_DIR, 'aria2c.exe');
const NM3U8DL_EXE = path.join(BIN_DIR, 'N_m3u8DL-RE.exe');
const BIN_FFMPEG_EXE = path.join(BIN_DIR, 'ffmpeg.exe');
const LEGACY_FFMPEG_DIR = path.join(__dirname, '..', 'hongguo-drama', 'build', 'ffmpeg');
const LEGACY_FFMPEG_EXE = path.join(LEGACY_FFMPEG_DIR, 'ffmpeg.exe');
const FFMPEG_EXE = fs.existsSync(BIN_FFMPEG_EXE) ? BIN_FFMPEG_EXE : LEGACY_FFMPEG_EXE;
const FFMPEG_DIR = path.dirname(FFMPEG_EXE);

const versionCache = new Map();

function isAvailable() {
  return fs.existsSync(YTDLP_EXE);
}

function isAria2Available() {
  return fs.existsSync(ARIA2C_EXE);
}

function isNm3u8dlAvailable() {
  return fs.existsSync(NM3U8DL_EXE);
}

function buildChildEnv() {
  const curPath = process.env.PATH || process.env.Path || '';
  return {
    ...process.env,
    PATH: `${BIN_DIR}${path.delimiter}${FFMPEG_DIR}${path.delimiter}${curPath}`,
  };
}

function killProcessTree(child) {
  if (!child) return;
  try { child.kill('SIGKILL'); } catch (_) {}
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });
      killer.unref();
    } catch (_) {}
  }
}

function getExeVersion(exePath, args = ['--version'], parseFn = (s) => s.trim()) {
  if (versionCache.has(exePath)) return Promise.resolve(versionCache.get(exePath));
  if (!fs.existsSync(exePath)) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve('');
    }, 5000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      const ver = parseFn(out) || '';
      if (ver) versionCache.set(exePath, ver);
      resolve(ver);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function getVersion() {
  return getExeVersion(YTDLP_EXE, ['--version'], (s) => s.trim());
}

function getAria2Version() {
  return getExeVersion(ARIA2C_EXE, ['--version'], (s) => {
    const m = s.match(/aria2 version\s+([^\s\r\n]+)/i);
    return m ? m[1] : s.split(/\r?\n/)[0]?.trim() || '';
  });
}

function getNm3u8dlVersion() {
  return getExeVersion(NM3U8DL_EXE, ['--version'], (s) => {
    const line = s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
    const m = line.match(/^([0-9]+\.[0-9]+\.[0-9]+)/);
    return m ? m[1] : line.slice(0, 16);
  });
}

const DRAMA_SOURCE_HOST_RE = /(?:^|\.)(novelquickapp\.com|hongguoduanju\.com|dramabox\.com|dramaboxdb\.com|reelshort\.com|kuaikaw\.cn|youlishipin\.com)$/i;

function isSocialVideoUrl(input) {
  const s = String(input || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return false;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (DRAMA_SOURCE_HOST_RE.test(u.hostname)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function detectPlatform(urlStr = '', extractor = '') {
  const text = `${extractor} ${urlStr}`.toLowerCase();
  if (text.includes('tiktok')) return { id: 'tiktok', name: 'TikTok', icon: '🎵' };
  if (text.includes('douyin')) return { id: 'douyin', name: 'Douyin (抖音)', icon: '🎼' };
  if (text.includes('youtube') || text.includes('youtu.be')) return { id: 'youtube', name: 'YouTube', icon: '▶️' };
  if (text.includes('facebook') || text.includes('fb.watch')) return { id: 'facebook', name: 'Facebook', icon: '📘' };
  if (text.includes('instagram')) return { id: 'instagram', name: 'Instagram', icon: '📸' };
  if (text.includes('bilibili') || text.includes('b23.tv')) return { id: 'bilibili', name: 'Bilibili', icon: '📺' };
  if (text.includes('kuaishou') || text.includes('kwai')) return { id: 'kuaishou', name: 'Kuaishou', icon: '🧡' };
  if (text.includes('dailymotion')) return { id: 'dailymotion', name: 'Dailymotion', icon: '🎬' };
  if (text.includes('pinterest') || text.includes('pin.it')) return { id: 'pinterest', name: 'Pinterest', icon: '📌' };
  if (text.includes('twitter') || text.includes('x.com')) return { id: 'twitter', name: 'X / Twitter', icon: '🐦' };
  if (text.includes('vimeo')) return { id: 'vimeo', name: 'Vimeo', icon: '🎞️' };
  if (text.includes('twitch')) return { id: 'twitch', name: 'Twitch', icon: '🟣' };
  if (extractor) return { id: extractor.toLowerCase(), name: extractor.replace(/:.*$/, ''), icon: '🌐' };
  return { id: 'web', name: 'Web Video', icon: '🌐' };
}

function sanitizeSafeName(str, fallback = 'Video') {
  const cleaned = String(str || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
  return cleaned.slice(0, 72) || fallback;
}

function translateYtdlpError(rawMsg) {
  const msg = String(rawMsg || '');
  if (!msg) return 'មិនអាចទាញយកព័ត៌មានវីដេអូពី Link នេះបានទេ';
  if (/fresh cookies|cookies|Sign in|login required|Log in|registered users/i.test(msg)) {
    return 'Platform នេះទាមទារ Cookie ពី Browser ដែលបាន Login (សូមជ្រើស Browser Cookie: Edge/Chrome ក្នុងជម្រើសខាងក្រោម!)';
  }
  if (/Private video|Video unavailable|unavailable|This video is private|has been removed/i.test(msg)) {
    return 'វីដេអូនេះត្រូវបានដាក់ជាឯកជន (Private) ឬត្រូវបានលុបចោល';
  }
  if (/Unsupported URL/i.test(msg)) {
    return 'Link នេះមិនត្រូវបានគាំទ្រ ឬមិនមានវីដេអូនៅលើទំព័រនេះទេ';
  }
  if (/HTTP Error 403|HTTP Error 429/i.test(msg)) {
    return 'Website បដិសេធសំណើ (403/429) — សាកល្បងជ្រើស Browser Cookie ឬព្យាយាមម្តងទៀត';
  }
  return msg.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 180);
}

const ALLOWED_COOKIE_BROWSERS = new Set(['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi']);

function parseSizeToBytes(numStr, unitStr) {
  const n = parseFloat(numStr);
  if (!Number.isFinite(n)) return 0;
  const u = String(unitStr || '').toLowerCase();
  if (u.startsWith('k')) return n * 1024;
  if (u.startsWith('m')) return n * 1024 * 1024;
  if (u.startsWith('g')) return n * 1024 * 1024 * 1024;
  return n;
}

function probeUrl(targetUrl, { cookiesFromBrowser = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      return reject(new Error(`រកមិនឃើញ yt-dlp.exe ក្នុង ${YTDLP_EXE}`));
    }
    if (!isSocialVideoUrl(targetUrl)) {
      return reject(new Error('សូមបញ្ចូល URL វីដេអូ HTTP/HTTPS ត្រឹមត្រូវ'));
    }

    const args = [
      '--dump-single-json',
      '--flat-playlist',
      '--playlist-end', '100',
      '--no-warnings',
      '--no-check-certificates',
    ];
    if (fs.existsSync(FFMPEG_EXE)) {
      args.push('--ffmpeg-location', FFMPEG_DIR);
    }
    const browser = String(cookiesFromBrowser || '').toLowerCase().trim();
    if (ALLOWED_COOKIE_BROWSERS.has(browser)) {
      args.push('--cookies-from-browser', browser);
    }
    args.push(targetUrl);

    const child = spawn(YTDLP_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('អស់ពេលវិភាគ Link វីដេអូ (35s) — សាកល្បងម្ដងទៀត ឬជ្រើស Browser Cookie'));
    }, 35000);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-3000); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      let info = null;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && (parsed.title || parsed.entries || parsed.extractor || parsed.id)) {
            info = parsed;
            break;
          }
        } catch (_) {}
      }
      if (!info && stdout.trim().startsWith('{')) {
        try { info = JSON.parse(stdout.trim()); } catch (_) {}
      }

      if (!info) {
        return reject(new Error(translateYtdlpError(stderr || `yt-dlp exited (${code})`)));
      }

      const rawEntries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
      const isPlaylist = info._type === 'playlist' && rawEntries.length > 1;
      const singleFallback = rawEntries.length === 1 ? rawEntries[0] : null;
      const activeInfo = singleFallback || info;

      const extractor = activeInfo.extractor_key || info.extractor_key || activeInfo.extractor || '';
      const platform = detectPlatform(targetUrl, extractor);
      const rawTitle = activeInfo.title || info.title || activeInfo.fulltitle || `${platform.name} Video ${activeInfo.id || ''}`;
      const thumb = activeInfo.thumbnail
        || (Array.isArray(activeInfo.thumbnails) && activeInfo.thumbnails.length ? activeInfo.thumbnails[activeInfo.thumbnails.length - 1].url : '')
        || info.thumbnail
        || (Array.isArray(info.thumbnails) && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : '');

      const entries = isPlaylist
        ? rawEntries.slice(0, 100).map((e, i) => ({
            index: Number(e.playlist_index) || (i + 1),
            id: String(e.id || i + 1),
            title: String(e.title || `វីដេអូទី ${i + 1}`),
            url: e.url || e.webpage_url || '',
            duration: Number(e.duration) || 0,
            thumbnail: e.thumbnail || '',
          }))
        : [];

      const qualities = [
        { id: 'best', label: '💎 ល្អបំផុត (Best MP4)' },
        { id: '1080p', label: '🎬 Full HD (1080p)' },
        { id: '720p', label: '⚡ HD (720p)' },
        { id: '480p', label: '📱 SD (480p)' },
        { id: 'mp3', label: '🎵 សំឡេងតែប៉ុណ្ណោះ (MP3)' },
      ];

      resolve({
        url: targetUrl,
        webpageUrl: activeInfo.webpage_url || targetUrl,
        id: String(activeInfo.id || info.id || Date.now()),
        title: String(rawTitle),
        titleSafe: sanitizeSafeName(rawTitle, `${platform.name}_${activeInfo.id || Date.now()}`),
        thumbnail: thumb || '',
        uploader: String(activeInfo.uploader || activeInfo.channel || info.uploader || ''),
        duration: Number(activeInfo.duration) || 0,
        extractor: String(extractor || platform.name),
        platform,
        isPlaylist,
        playlistCount: isPlaylist ? rawEntries.length : 1,
        entries,
        qualities,
      });
    });
  });
}

function buildQualityArgs(qualityPreset) {
  switch (qualityPreset) {
    case 'mp3':
      return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    case '1080p':
      return [
        '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '--merge-output-format', 'mp4',
      ];
    case '720p':
      return [
        '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '--merge-output-format', 'mp4',
      ];
    case '480p':
      return [
        '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best',
        '--merge-output-format', 'mp4',
      ];
    default:
      return [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
      ];
  }
}

function runYtdlpProcess(args, {
  signal,
  activeChildren,
  initialTotalItems = 1,
  onProgress,
  onLog,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      return reject(new Error(`រកមិនឃើញ yt-dlp.exe ក្នុង ${YTDLP_EXE}`));
    }
    if (signal?.aborted) return reject(new Error('CANCELLED'));

    const child = spawn(YTDLP_EXE, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnv(),
    });
    activeChildren?.add(child);

    let lineBuf = '';
    let errBuf = '';
    let currentItem = 1;
    let totalItems = initialTotalItems;
    let lastStreamBytes = 0;
    let finishedDest = '';

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      const itemMatch = line.match(/^\[download\]\s+Downloading item\s+(\d+)\s+of\s+(\d+)/i);
      if (itemMatch) {
        currentItem = parseInt(itemMatch[1], 10) || 1;
        totalItems = parseInt(itemMatch[2], 10) || totalItems;
        lastStreamBytes = 0;
        onProgress?.({ currentItem, totalItems, itemPct: 0, speedText: '0.0 MB/s', bytesDelta: 0, receivedBytes: 0, phase: 'downloading' });
        onLog?.(`⬇️ កំពុងទាញវីដេអូ ${currentItem}/${totalItems}...`);
        return;
      }

      const dlMatch = line.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMG]i?B)\s+at\s+([^\s]+)(?:\s+ETA\s+(\S+))?/i);
      if (dlMatch) {
        const pct = Math.min(99, Math.max(0, Math.round(parseFloat(dlMatch[1]) || 0)));
        const totalB = parseSizeToBytes(dlMatch[2], dlMatch[3]);
        const curBytes = Math.round((pct / 100) * totalB);
        const delta = Math.max(0, curBytes - lastStreamBytes);
        lastStreamBytes = Math.max(lastStreamBytes, curBytes);
        const spStr = dlMatch[4] && dlMatch[4] !== 'Unknown' ? dlMatch[4].replace('MiB/s', 'MB/s').replace('KiB/s', 'KB/s') : '0.0 MB/s';
        onProgress?.({ currentItem, totalItems, itemPct: pct, speedText: spStr, bytesDelta: delta, receivedBytes: lastStreamBytes, totalBytes: totalB, phase: 'downloading', eta: dlMatch[5] || '' });
        return;
      }

      // When yt-dlp delegates transport to aria2c, parse aria2c's live summary progress lines too.
      const ariaMatch = line.match(/^\[#[0-9a-f]+\s+([\d.]+)([KMG]?i?B)\/([\d.]+)([KMG]?i?B)\((\d+)%\).*?DL:([\d.]+[KMG]?i?B)(?:.*?ETA:([^\s\]]+))?/i);
      if (ariaMatch) {
        const curBytes = Math.round(parseSizeToBytes(ariaMatch[1], ariaMatch[2]));
        const totalB = Math.round(parseSizeToBytes(ariaMatch[3], ariaMatch[4]));
        const pct = Math.min(99, Math.max(0, parseInt(ariaMatch[5], 10) || 0));
        const delta = Math.max(0, curBytes - lastStreamBytes);
        lastStreamBytes = Math.max(lastStreamBytes, curBytes);
        const spStr = `${ariaMatch[6].replace('MiB', 'MB').replace('KiB', 'KB')}/s`;
        onProgress?.({ currentItem, totalItems, itemPct: pct, speedText: spStr, bytesDelta: delta, receivedBytes: lastStreamBytes, totalBytes: totalB, phase: 'downloading', eta: ariaMatch[7] || '' });
        return;
      }

      if (/^\[(?:Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/i.test(line)) {
        onProgress?.({ currentItem, totalItems, itemPct: 95, speedText: 'FFmpeg Mux', bytesDelta: 0, receivedBytes: lastStreamBytes, phase: 'transcoding' });
        onLog?.('⚙️ កំពុងបំប្លែង / ផ្គុំរូបភាព និងសំឡេង (FFmpeg)...');
      }

      const destMatch = line.match(/^\[(?:download|Merger|ExtractAudio)\]\s+(?:Destination:|Merging formats into\s+"?|"?(.+\.(?:mp4|mkv|webm|mp3))"?)/i);
      if (destMatch) {
        const cleanDest = line.replace(/^.*?(?:Destination:|into)\s+"?/i, '').replace(/"$/, '').trim();
        if (cleanDest && fs.existsSync(cleanDest)) finishedDest = cleanDest;
      }
    };

    child.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || '';
      for (const p of parts) handleLine(p);
    });

    child.stderr.on('data', (chunk) => {
      errBuf = (errBuf + chunk.toString('utf8')).slice(-2500);
    });

    const onAbort = () => {
      killProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (lineBuf.trim()) handleLine(lineBuf);
      if (signal?.aborted) return reject(new Error('CANCELLED'));
      resolve({ code, errBuf, finishedDest });
    });

    child.on('error', (err) => {
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

function collectValidMediaFiles(outputDir) {
  return fs.readdirSync(outputDir)
    .filter((f) => /\.(mp4|mkv|webm|mp3|m4a)$/i.test(f) && !/\.part$/i.test(f) && !/\.aria2$/i.test(f) && !/^temp_/i.test(f))
    .map((f) => path.join(outputDir, f))
    .filter((p) => {
      try { return fs.statSync(p).size >= 1024; } catch (_) { return false; }
    });
}

function cleanAriaTempFiles(outputDir) {
  try {
    for (const f of fs.readdirSync(outputDir)) {
      if (/\.(aria2|part|ytdl)$/i.test(f)) {
        try { fs.unlinkSync(path.join(outputDir, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

async function downloadYtdlp({
  url,
  outputDir,
  filePrefix,
  isPlaylist = false,
  selectedIndices = null,
  qualityPreset = 'best',
  cookiesFromBrowser = '',
  useAria2 = true,
  signal,
  activeChildren,
  onProgress,
  onLog,
}) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const safePrefix = sanitizeSafeName(filePrefix || 'Video', 'Video');
  const outTpl = isPlaylist
    ? path.join(outputDir, 'EP%(autonumber)03d - %(title).55s.%(ext)s')
    : path.join(outputDir, `${safePrefix}.%(ext)s`);

  const buildArgs = (enableAria2) => {
    const args = [
      '--newline',
      '--no-warnings',
      '--no-check-certificates',
      '--no-mtime',
      ...buildQualityArgs(qualityPreset),
      '-o', outTpl,
    ];
    if (fs.existsSync(FFMPEG_EXE)) {
      args.push('--ffmpeg-location', FFMPEG_DIR);
    }
    if (enableAria2 && isAria2Available()) {
      args.push('--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 16 -s 16 -k 1M');
    }
    if (isPlaylist) {
      args.push('--ignore-errors');
      if (Array.isArray(selectedIndices) && selectedIndices.length > 0) {
        const listStr = selectedIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 1).join(',');
        if (listStr) args.push('--playlist-items', listStr);
      }
    } else {
      args.push('--no-playlist');
    }
    const browser = String(cookiesFromBrowser || '').toLowerCase().trim();
    if (ALLOWED_COOKIE_BROWSERS.has(browser)) {
      args.push('--cookies-from-browser', browser);
    }
    args.push(url);
    return args;
  };

  const initialTotalItems = isPlaylist && Array.isArray(selectedIndices) && selectedIndices.length ? selectedIndices.length : 1;
  const shouldUseAria2 = useAria2 !== false && isAria2Available();
  if (shouldUseAria2) {
    onLog?.('⚡ បើកដំណើរការ aria2c (-x 16 -s 16 -k 1M) សម្រាប់បង្កើនល្បឿនទាញយក...');
  }

  try {
    let result = await runYtdlpProcess(buildArgs(shouldUseAria2), {
      signal,
      activeChildren,
      initialTotalItems,
      onProgress,
      onLog,
    });
    let validFiles = collectValidMediaFiles(outputDir);

    // Fallback to native yt-dlp downloader if aria2c failed on an incompatible CDN/stream
    if (shouldUseAria2 && result.code !== 0 && !signal?.aborted && !(isPlaylist && validFiles.length > 0)) {
      cleanAriaTempFiles(outputDir);
      onLog?.('⚠️ Host នេះមិនត្រូវគ្នាជាមួយ aria2c — ប្ដូរទៅ yt-dlp ធម្មតាដោយស្វ័យប្រវត្តិ...');
      result = await runYtdlpProcess(buildArgs(false), {
        signal,
        activeChildren,
        initialTotalItems,
        onProgress,
        onLog,
      });
      validFiles = collectValidMediaFiles(outputDir);
    }

    if (result.code === 0 && validFiles.length > 0) {
      return { files: validFiles, count: validFiles.length, mainFile: result.finishedDest || validFiles[0] };
    }
    if (isPlaylist && validFiles.length > 0) {
      return { files: validFiles, count: validFiles.length, partial: true, error: translateYtdlpError(result.errBuf) };
    }
    throw new Error(translateYtdlpError(result.errBuf || `yt-dlp exited (${result.code})`));
  } finally {
    if (signal?.aborted) cleanAriaTempFiles(outputDir);
  }
}

/**
 * Multi-connection HLS (.m3u8) downloader using yt-dlp concurrent fragments (6x+ faster than serial staging).
 */
async function downloadHlsStream({
  url,
  outputFile,
  referer = '',
  userAgent = '',
  concurrentFragments = 8,
  signal,
  activeChildren,
  onProgress,
} = {}) {
  const dir = path.dirname(outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const args = [
    '--newline',
    '--no-warnings',
    '--no-check-certificates',
    '--no-mtime',
    '-N', String(concurrentFragments),
  ];
  if (fs.existsSync(FFMPEG_EXE)) {
    args.push('--ffmpeg-location', FFMPEG_DIR);
  }
  if (userAgent) args.push('--add-headers', `User-Agent:${userAgent}`);
  if (referer) args.push('--add-headers', `Referer:${referer}`);
  args.push('-o', outputFile, url);

  try {
    const { code, errBuf } = await runYtdlpProcess(args, {
      signal,
      activeChildren,
      initialTotalItems: 1,
      onProgress,
    });
    if (code !== 0 || !fs.existsSync(outputFile) || fs.statSync(outputFile).size < 1024) {
      throw new Error(translateYtdlpError(errBuf || `yt-dlp HLS exited (${code})`));
    }
    return { file: outputFile, size: fs.statSync(outputFile).size };
  } finally {
    const base = path.basename(outputFile);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${base}.part`) || f === `${base}.ytdl`) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
}

module.exports = {
  BIN_DIR,
  YTDLP_EXE,
  ARIA2C_EXE,
  NM3U8DL_EXE,
  isAvailable,
  isAria2Available,
  isNm3u8dlAvailable,
  getVersion,
  getAria2Version,
  getNm3u8dlVersion,
  isSocialVideoUrl,
  detectPlatform,
  probeUrl,
  downloadYtdlp,
  downloadHlsStream,
  sanitizeSafeName,
  parseSizeToBytes,
  killProcessTree,
};

