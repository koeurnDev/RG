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

// Robust episode list fetcher with caching and curl fallback
async function fetchEpisodeListSafe(seriesId) {
  const sid = String(seriesId).trim();
  if (dramaCache.has(sid)) return dramaCache.get(sid);

  const localHtml = path.join(__dirname, 'detail_page.html');
  let html = '';

  // Try curl directly
  try {
    const tempFile = path.join(__dirname, `temp_detail_${sid}.html`);
    execSync(`curl.exe -s -L -m 15 "https://hongguoduanju.com/detail?series_id=${sid}" -o "${tempFile}"`);
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
      html = fs.readFileSync(tempFile, 'utf8');
      fs.unlinkSync(tempFile);
    }
  } catch (_) {}

  // Fallback to local detail_page.html if available
  if (!html && fs.existsSync(localHtml)) {
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

  // Final fallback to native hongguo module
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

    // Launch workers in parallel
    const workerPromises = [];
    const concurrency = Math.min(workers, queue.length);
    for (let i = 0; i < concurrency; i++) {
      workerPromises.push(downloadWorker());
    }
    await Promise.all(workerPromises);

    // Auto-merge if requested
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
    
    /* Left Panel: Library */
    .left-panel { width: 330px; background: var(--bg-panel); border-right: 1px solid var(--border); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
    .panel-title { font-size: 14px; font-weight: 700; color: #fff; display: flex; justify-content: space-between; align-items: center; }
    .drama-card-mini { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px; display: flex; gap: 12px; cursor: pointer; transition: 0.2s; }
    .drama-card-mini:hover { border-color: var(--primary); transform: translateX(3px); background: var(--bg-hover); }
    .mini-cover { width: 55px; height: 75px; border-radius: 6px; object-fit: cover; background: #0c1017; flex-shrink: 0; }
    .mini-title { font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-khmer { font-size: 11px; color: #90cdf4; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(49, 130, 206, 0.2); color: #63b3ed; font-weight: 600; }

    /* Right Panel */
    .main-panel { flex: 1; padding: 20px 24px; display: flex; flex-direction: column; gap: 18px; }

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
      <span class="brand-badge">DOWNLOADER</span>
    </div>

    <div class="search-bar">
      <button class="btn-paste" onclick="pasteClipboard()">📋 Paste</button>
      <input type="text" id="globalSearchInput" class="search-input" placeholder="វាយឈ្មោះរឿង (ឧ. 装穷提亲) ឬ Series ID ឬ Link..." value="7701328280862854168">
      <button class="search-btn" onclick="handleSearch()">🔍 ស្វែងរក</button>
    </div>

    <div class="top-actions">
      <button class="btn-folder" onclick="openFolder()">📂 បើក Folder វីដេអូ</button>
    </div>
  </div>

  <div class="app-body">
    
    <!-- Left Panel -->
    <div class="left-panel">
      <div class="panel-title">
        <span>📚 រឿងភាគល្បីៗ (Trending)</span>
        <span style="font-size: 11px; color: #68d391;">Auto Ready</span>
      </div>
      
      <div class="drama-card-mini" onclick="loadDrama('7701328280862854168', '装穷提亲，娶到全家嫌弃的她', 'https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image', 80, 'បន្លំធ្វើជាអ្នកក្រទៅស្តីដណ្តឹង រៀបការជាមួយនារីដែលគ្រួសារមើលងាយ')">
        <img src="https://p6-novel.byteimg.com/novel-pic/dd47bf8f4357b931ef542a2f91478aed~tplv-shrink:640:0.image" class="mini-cover">
        <div style="display: flex; flex-direction: column; justify-content: center; overflow: hidden;">
          <div class="mini-title">装穷提亲，娶到全家嫌弃的她</div>
          <div class="mini-khmer">បន្លំធ្វើជាអ្នកក្រទៅស្តីដណ្តឹង...</div>
          <div><span class="mini-tag">80 ភាគពេញ</span></div>
        </div>
      </div>

      <div class="drama-card-mini" onclick="loadDrama('7701334722449787928', '一念沉沦，霍总心动了', 'https://p3-novel.byteimg.com/novel-pic/a88c32bc76db787599cb51b2c451da77~tplv-shrink:640:0.image', 96, 'មួយភ្លែតលង់ចិត្ត លោកប្រធាន ហួ...')">
        <img src="https://p3-novel.byteimg.com/novel-pic/a88c32bc76db787599cb51b2c451da77~tplv-shrink:640:0.image" class="mini-cover">
        <div style="display: flex; flex-direction: column; justify-content: center; overflow: hidden;">
          <div class="mini-title">一念沉沦，霍总心动了</div>
          <div class="mini-khmer">មួយភ្លែតលង់ចិត្ត លោកប្រធាន ហួ...</div>
          <div><span class="mini-tag">96 ភាគពេញ</span></div>
        </div>
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

      <!-- Live Progress Bar Card -->
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

      <!-- Episodes Grid -->
      <div class="episodes-section">
        <div class="ep-header">
          <div>
            <div class="ep-title">📋 បញ្ជីភាគរឿង (ចុចលើភាគណា ទាញយកភាគនោះភ្លាមៗ)</div>
            <div id="epStats" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">បានទាញយក: 1 ភាគ (ភាគ 1 រួចរាល់) | នៅសល់: 79 ភាគ</div>
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
      // Start downloading this episode immediately!
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

    function loadDrama(id, title, cover, total, titleKhmer) {
      currentDrama = { seriesId: id, title, cover, total, titleKhmer };
      document.getElementById('bannerTitle').innerText = title;
      document.getElementById('bannerKhmer').innerText = titleKhmer || title;
      document.getElementById('bannerCover').src = cover;
      document.getElementById('bannerId').innerText = 'Series ID: ' + id;
      document.getElementById('bannerTotal').innerText = 'សរុប: ' + total + ' ភាគ';
      document.getElementById('btnDownloadAll').innerText = \`🚀 ទាញយកគ្រប់ភាគទាំងអស់ (ភាគ 1 ដល់ \${total})\`;

      episodeStates = {};
      for (let i = 1; i <= total; i++) {
        episodeStates[i] = 'pending';
      }
      renderEpisodesGrid();

      // Check existing files on disk
      fetch('/api/scanned-episodes?seriesId=' + id).then(r => r.json()).then(data => {
        if (data && data.downloaded && data.downloaded.length > 0) {
          data.downloaded.forEach(ep => { episodeStates[ep] = 'done'; });
          renderEpisodesGrid();
        }
      }).catch(() => {});
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

    // Download ALL Episodes
    function downloadAllEpisodes() {
      const selectedEps = [];
      for (let ep = 1; ep <= currentDrama.total; ep++) {
        if (episodeStates[ep] !== 'done') selectedEps.push(ep);
      }
      if (selectedEps.length === 0) return alert('គ្រប់ភាគទាំងអស់ត្រូវបានទាញយករួចរាល់ហើយ!');

      triggerDownload(selectedEps);
    }

    // Download a Single Episode (e.g. EP 2)
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

    window.onload = () => {
      loadDrama(currentDrama.seriesId, currentDrama.title, currentDrama.cover, currentDrama.total, currentDrama.titleKhmer);
    };
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

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`HDRG Pro Plus Downloader running at: http://localhost:${PORT}`);
});
