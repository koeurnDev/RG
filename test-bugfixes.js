const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('ui_server Range requests, cover-hd folder hygiene, and saveConfig isolation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-dl-bugfix-'));
  const dlRoot = path.join(tmpDir, 'Downloads');
  fs.mkdirSync(dlRoot, { recursive: true });
  const origEnv = { ...process.env };

  process.env.EZA_PACKAGED_CLIENT = '1';
  process.env.EZA_REQUIRE_CLOUD_LICENSE = '0';
  process.env.HDRG_ISOLATED = '1';
  process.env.EZA_USER_DATA_DIR = tmpDir;
  process.env.HDRG_CONFIG_FILE = path.join(tmpDir, 'config.json');
  process.env.EZA_DEFAULT_DOWNLOAD_DIR = dlRoot;

  // Create valid MP4 sample with known tail bytes for suffix-range test
  const dramaFolder = path.join(dlRoot, 'TestSeries');
  fs.mkdirSync(dramaFolder, { recursive: true });
  const header = Buffer.from('000000186674797069736f6d', 'hex'); // ....ftypisom
  const body = Buffer.alloc(35000, 0x41);
  const tail = Buffer.from('0123456789ABCDEF', 'utf8');
  const sampleMp4 = Buffer.concat([header, body, tail]);
  fs.writeFileSync(path.join(dramaFolder, 'EP001.mp4'), sampleMp4);

  // Local mock server for JPEG cover
  const jpegBuf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2044, 0x55)]);
  const imgServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpegBuf.length });
    res.end(jpegBuf);
  });
  await new Promise((r) => imgServer.listen(0, '127.0.0.1', r));
  const imgPort = imgServer.address().port;

  let started = null;
  try {
    // Clear cached ui_server if loaded earlier in same process
    delete require.cache[require.resolve('./ui_server')];
    const uiServer = require('./ui_server');
    started = await uiServer.startServer({ port: 0, host: '127.0.0.1', warmUp: false });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    // 1. Suffix Range (bytes=-16) returns last 16 bytes cleanly
    const suffixRes = await fetch(`${baseUrl}/api/video?folder=TestSeries&ep=1`, {
      headers: { Range: 'bytes=-16' },
    });
    assert.equal(suffixRes.status, 206);
    assert.equal(suffixRes.headers.get('content-range'), `bytes ${sampleMp4.length - 16}-${sampleMp4.length - 1}/${sampleMp4.length}`);
    assert.equal(await suffixRes.text(), '0123456789ABCDEF');

    // 2. Out-of-bounds Range returns 416 Range Not Satisfiable
    const oobRes = await fetch(`${baseUrl}/api/video?folder=TestSeries&ep=1`, {
      headers: { Range: 'bytes=99999999-' },
    });
    assert.equal(oobRes.status, 416);
    assert.equal(oobRes.headers.get('content-range'), `bytes */${sampleMp4.length}`);

    // 3. Cover HD when drama folder does NOT exist on disk creates NO ghost folder in dlRoot
    const covGhostRes = await fetch(
      `${baseUrl}/api/cover-hd?cover=${encodeURIComponent(`http://127.0.0.1:${imgPort}/p.jpg`)}&title=${encodeURIComponent('ចំណងជើងខ្មែរ')}&folder=${encodeURIComponent('NonExistentDrama')}`
    );
    assert.equal(covGhostRes.status, 200);
    assert.equal(fs.existsSync(path.join(dlRoot, 'ចំណងជើងខ្មែរ')), false);
    assert.equal(fs.existsSync(path.join(dlRoot, 'NonExistentDrama')), false);

    // 4. Cover HD when real folder exists saves cover.jpg inside real folder (not Khmer title folder)
    const covRealRes = await fetch(
      `${baseUrl}/api/cover-hd?cover=${encodeURIComponent(`http://127.0.0.1:${imgPort}/p.jpg`)}&title=${encodeURIComponent('ចំណងជើងខ្មែរ')}&folder=${encodeURIComponent('TestSeries')}`
    );
    assert.equal(covRealRes.status, 200);
    assert.equal(fs.existsSync(path.join(dramaFolder, 'cover.jpg')), true);
    assert.equal(fs.existsSync(path.join(dlRoot, 'ចំណងជើងខ្មែរ')), false);

    // 5. saveConfig writes only to HDRG_CONFIG_FILE
    uiServer.saveConfig({ GEMINI_API_KEY: 'test_key_123' });
    const savedCfg = JSON.parse(fs.readFileSync(process.env.HDRG_CONFIG_FILE, 'utf8'));
    assert.equal(savedCfg.GEMINI_API_KEY, 'test_key_123');
  } finally {
    try { if (started) require('./ui_server').stopServer(); } catch (_) {}
    try { imgServer.close(); } catch (_) {}
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ytdlp URL extraction/validation, hardware-encoder args, and playback-device refresh', async () => {
  const ytdlp = require('./lib/ytdlp');
  assert.equal(ytdlp.extractFirstHttpUrl('分享视频 https://v.douyin.com/xyz123/ 复制'), 'https://v.douyin.com/xyz123/');
  await assert.rejects(
    ytdlp.downloadYtdlp({ url: 'invalid-non-http-input', outputDir: os.tmpdir() }),
    /HTTP\/HTTPS/
  );

  const hw = require('./hongguo-drama/src/native/hardware-encoder');
  assert.equal(hw.hardwareEncoderArgs('h264_nvenc')[1], 'h264_nvenc');
  assert.equal(hw.hardwareEncoderArgs('unknown')[1], 'libx264');
  assert.deepEqual(await hw.pickHardwareEncoder({ executable: '' }), { encoder: null });

  const { getPlaybackDevice, refreshPlaybackDevice } = require('./hongguo-drama/src/native/playback-device');
  let n = 0;
  const fakeReq = async () => ({ code: 0, data: { device_id: String(++n * 111), install_id: String(n * 222) }, device_id_str: String(n * 111), install_id_str: String(n * 222) });
  const d1 = await getPlaybackDevice(fakeReq);
  assert.equal(d1.device_id, '111');
  const d2 = await refreshPlaybackDevice(fakeReq);
  assert.equal(d2.device_id, '222');
  const d3 = await getPlaybackDevice(fakeReq);
  assert.equal(d3.device_id, '222');
});

test('index.html inline script compiles cleanly and preserves 720p/hasMore/compress UI fixes', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/i);
  assert.ok(m && m[1], 'Expected inline script block in public/index.html');
  new vm.Script(m[1], { filename: 'public/index.html' });
  assert.match(m[1], /savedQual === '720p'/);
  assert.match(m[1], /hasMore:\s*true/);
  assert.match(m[1], /snap\.speedText === 'FFmpeg Compress'/);
});

test('downloader translates EMPTY_RESPONSE fast-fail to helpful Khmer recommendation', () => {
  const dl = require('./lib/downloader');
  const khmer1 = dl.translateNativeErrorToKhmer('EMPTY_RESPONSE');
  const khmer2 = dl.translateNativeErrorToKhmer('接口返回空响应（HTTP 200，0 字节）');
  assert.match(khmer1, /Server HONGGUO ឆ្លើយតបទទេ/);
  assert.match(khmer1, /ByteDance WAF/);
  assert.match(khmer1, /HEMA, DRAMABOX, XIFAN/);
  assert.equal(khmer1, khmer2);
});

test('signPlaybackV5 supports bodyless GET and app-source recovers from empty PLAYER_API via video_tab V5 GET', async () => {
  const { signPlaybackV5 } = require('./hongguo-drama/src/native/playback-v5');
  const base = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';
  const signedGet = signPlaybackV5({
    base,
    values: {
      aid: '8662', app_name: 'novelread', version_code: '74332', version_name: '7.4.3.32',
      channel: 'vivo_8662_64', device_platform: 'android', device_type: 'PGT-AN10',
      os_version: '12', update_version_code: '74332',
      iid: '1000000000000002', cdid: '11111111-1111-4111-8111-111111111111', device_id: '1000000000000001',
      video_id: '7700946421087751193', video_id_type: '0', device_level: '1',
      need_all_video_definition: '1', need_mp4_align: '0', use_os_player: '0',
      video_platform: '1024', source: '0', from_video_id: '',
    },
    body: null,
    now: 1795000000000,
  });
  assert.ok(signedGet.url.startsWith(base + '?'));
  assert.ok(signedGet.headers['x-khronos']);
  assert.ok(signedGet.headers['x-helios']);
  assert.ok(signedGet.headers['x-medusa']);
  assert.equal(signedGet.headers['x-ss-stub'], undefined);
  assert.equal(signedGet.headers['x-ss-req-ticket'], undefined);

  const calls = [];
  const mod = { exports: {} };
  const appPath = require.resolve('./hongguo-drama/src/native/app-source');
  const mediaUrl = 'https://v3-reading-video.qznovelvod.com/synthetic.mp4';
  const modelPayload = {
    code: 0,
    data: {
      video_model_data: {
        '7700946421087751193': {
          video_model: {
            video_id: 'synthetic-video',
            video_duration: 60,
            video_list: {
              hd: {
                codec_type: 'h264',
                vwidth: 1080,
                vheight: 1920,
                quality_desc: '1080p',
                main_url: mediaUrl,
                encrypt_info: { encrypt: false },
              },
            },
          },
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    module: mod,
    Buffer,
    URL,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === './playback-device') {
        return {
          registerPlaybackDevice: async () => ({
            device_id: '1000000000000001',
            iid: '1000000000000002',
            cdid: '11111111-1111-4111-8111-111111111111',
          }),
        };
      }
      if (name === 'axios') {
        return async (config) => {
          const u = new URL(config.url);
          calls.push({ method: config.method, host: u.hostname, pathname: u.pathname, headers: config.headers, data: config.data });
          if (u.pathname === '/novel/player/multi_video_model/player/v1') {
            return { status: 200, headers: {}, data: '' };
          }
          if (u.pathname === '/novel/player/video_model/v1/') {
            return { status: 200, headers: {}, data: '' };
          }
          if (u.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/') {
            return { status: 200, headers: {}, data: JSON.stringify(modelPayload) };
          }
          throw new Error('Unexpected request: ' + config.url);
        };
      }
      return require(name.startsWith('.') ? path.join(path.dirname(appPath), name) : name);
    },
  });

  const play = await mod.exports.fetchAppPlayUrl('7700946421087751193', { quality: '720p', allowLowerQuality: true });
  assert.equal(play.url, mediaUrl);
  assert.equal(calls.length, 9);
  assert.ok(calls.some(c => c.pathname === '/novel/player/multi_video_model/player/v1'));
  assert.ok(calls.some(c => c.pathname === '/novel/player/video_model/v1/'));
  assert.ok(calls.some(c => c.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/'));
  const tabCall = calls[calls.length - 1];
  assert.equal(tabCall.method, 'GET');
  assert.equal(tabCall.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
  assert.equal(tabCall.data, null);
  assert.equal(tabCall.headers['x-ss-stub'], undefined);
  assert.equal(tabCall.headers['Content-Type'], undefined);
});

test('upstream-watcher detects new GitHub commits/releases and formats Telegram & Issue alerts', async () => {
  const watcher = require('./lib/upstream-watcher');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-upstream-'));
  const syncPath = path.join(tmpDir, 'upstream-sync.json');
  try {
    watcher.writeSyncState({
      updatedAt: '2026-11-21T00:00:00Z',
      repos: {
        'jackotom/hongguo-drama': {
          label: 'HongGuo Drama',
          branch: 'main',
          commitPath: 'src/native',
          syncedSha: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          syncedRelease: '7.8',
          trackLatestRelease: true,
        },
      },
    }, syncPath);

    const mockReqUpToDate = async (url) => {
      if (url.includes('/commits')) {
        return {
          status: 200,
          json: [{ sha: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', html_url: 'https://github.com/jackotom/hongguo-drama/commit/1111111', commit: { message: 'same', author: { date: '2026-11-21T00:00:00Z' } } }],
        };
      }
      if (url.includes('/releases/latest')) {
        return { status: 200, json: { tag_name: 'v7.8', html_url: 'https://github.com/jackotom/hongguo-drama/releases/tag/v7.8', published_at: '2026-11-21T05:00:00Z' } };
      }
      return { status: 404, json: null };
    };

    const okReport = await watcher.checkAllUpstreams({ force: true, syncFilePath: syncPath, requestFn: mockReqUpToDate });
    assert.equal(okReport.hasUpdates, false);
    assert.equal(watcher.buildUpdateSignature(okReport), '');

    const mockReqUpdated = async (url) => {
      if (url.includes('/commits')) {
        return {
          status: 200,
          json: [{ sha: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', html_url: 'https://github.com/jackotom/hongguo-drama/commit/2222222', commit: { message: 'fix: new v8 signing', author: { date: '2026-11-22T01:00:00Z' } } }],
        };
      }
      if (url.includes('/releases/latest')) {
        return { status: 200, json: { tag_name: 'v7.9', html_url: 'https://github.com/jackotom/hongguo-drama/releases/tag/v7.9', published_at: '2026-11-22T02:00:00Z' } };
      }
      if (url.includes('/compare/')) {
        return { status: 200, json: { files: [{ filename: 'src/native/app-source.js' }, { filename: 'README.md' }] } };
      }
      return { status: 404, json: null };
    };

    const updReport = await watcher.checkAllUpstreams({ force: true, syncFilePath: syncPath, requestFn: mockReqUpdated });
    assert.equal(updReport.hasUpdates, true);
    assert.equal(updReport.repos[0].hasNewCommit, true);
    assert.equal(updReport.repos[0].hasNewRelease, true);
    assert.deepEqual(updReport.repos[0].changedFiles, ['src/native/app-source.js']);

    const sig = watcher.buildUpdateSignature(updReport);
    assert.equal(sig, 'jackotom/hongguo-drama@2222222:v7.9');
    const tg = watcher.formatTelegramMessage(updReport, 'koeurnDev/RG');
    assert.match(tg, /v7\.9/);
    assert.match(tg, /2222222/);
    const issueBody = watcher.formatGithubIssueBody(updReport);
    assert.match(issueBody, /<!-- upstream-shas:jackotom\/hongguo-drama@2222222:v7\.9 -->/);

    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345\n987654321\n', 'utf8');
    const origTok = process.env.TELEGRAM_BOT_TOKEN;
    const origChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      const loaded = watcher.loadTelegramConfigFromEnvFile(envFile);
      assert.equal(loaded.botToken, '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345');
      assert.equal(loaded.chatId, '987654321');
    } finally {
      if (origTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = origTok;
      if (origChat !== undefined) process.env.TELEGRAM_CHAT_ID = origChat;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dramawave/netshort/goodshort resolvers, AES roundtrip, and custom-cms MacCMS adapter + SSRF guard', async () => {
  const axios = require('axios');
  const dw = require('./lib/dramawave');
  const ns = require('./lib/netshort');
  const gs = require('./lib/goodshort');
  const customCms = require('./lib/custom-cms');
  const sources = require('./lib/sources');

  // AES-128-CBC roundtrip for DramaWave payload helper
  const key = Buffer.from('2r36789f45q01ae5', 'utf8');
  const sampleJson = JSON.stringify({ code: 200, ok: true, list: [1, 2, 3] });
  const encrypted = dw._aesEncrypt(sampleJson, key);
  assert.strictEqual(dw._aesDecrypt(encrypted, key), sampleJson);
  assert.throws(() => dw._aesDecrypt('AAAA', key), /too short/);

  // Overseas ID/URL resolution and host validation
  assert.strictEqual(dw.resolveSeriesId('https://m.mydramawave.com/series/PWXh47pph6/ep1'), 'dramawave:PWXh47pph6');
  assert.throws(() => dw.resolveSeriesId('https://evil.example.com/series/PWXh47pph6'), /មិនមែនជា DramaWave/);
  assert.strictEqual(ns.resolveSeriesId('https://netshort.com/episode/demo-2117444629119504385'), 'netshort:2117444629119504385');
  assert.throws(() => ns.resolveSeriesId('https://evil.example.com/episode/2117444629119504385'), /មិនមែនជា NetShort/);
  assert.strictEqual(gs.resolveSeriesId('https://www.goodshort.com/drama/my-drama-31001955313'), 'goodshort:31001955313');
  assert.throws(() => gs.resolveSeriesId('https://evil.example.com/drama/31001955313'), /មិនមែនជា GoodShort/);

  // Custom CMS SSRF + normalization + mocked MacCMS catalog/episodes/playUrl
  assert.throws(() => customCms.validateSource({ name: 'Local', url: 'http://127.0.0.1/api.php/provide/vod/' }), /Public/);
  assert.throws(() => customCms.validateSource({ name: 'LAN', url: 'http://192.168.1.10/api.php/provide/vod/' }), /Public/);
  const validSrc = customCms.validateSource({ name: 'TestCMS', url: 'https://cms.example.com' });
  assert.strictEqual(validSrc.url, 'https://cms.example.com/api.php/provide/vod/');

  const origGet = axios.get;
  try {
    sources.setCustomSources([validSrc]);
    const listedIds = sources.getSourcesList().map((s) => s.id);
    assert.ok(listedIds.includes(`custom:${validSrc.id}`), 'custom source present in getSourcesList');
    assert.ok(listedIds.indexOf(`custom:${validSrc.id}`) < listedIds.indexOf('social'), 'custom source ordered before social');
    assert.strictEqual(sources.detectSourceFromId(`custom:${validSrc.id}:901`), `custom:${validSrc.id}`);
    assert.strictEqual(sources.resolveDramaUrlOrId(`custom:${validSrc.id}:901`), `custom:${validSrc.id}:901`);

    axios.get = async (reqUrl) => {
      const u = new URL(reqUrl);
      if (u.searchParams.get('ids') === '901') {
        return {
          data: JSON.stringify({
            code: 1,
            list: [{
              vod_id: 901,
              vod_name: 'Sample MacCMS Drama',
              vod_pic: 'https://cdn.example.com/cover.jpg',
              vod_total: 2,
              vod_play_from: 'm3u8$$$mp4',
              vod_play_url: '第1集$https://cdn.example.com/1.m3u8#第2集$https://cdn.example.com/2.m3u8$$$第1集$https://cdn.example.com/1.mp4',
            }],
          }),
        };
      }
      return {
        data: JSON.stringify({
          code: 1,
          pagecount: 2,
          total: 20,
          class: [{ type_id: 11, type_name: '短剧' }],
          list: [{ vod_id: 901, vod_name: 'Sample MacCMS Drama', vod_pic: 'https://cdn.example.com/cover.jpg', vod_total: 2, type_name: '短剧' }],
        }),
      };
    };

    const testRes = await sources.testCustomSource({ name: 'TestCMS', url: validSrc.url });
    assert.strictEqual(testRes.success, true);
    assert.strictEqual(testRes.count, 1);

    const cat = await sources.browseSourceCatalog(`custom:${validSrc.id}`, { page: 1 });
    assert.strictEqual(cat.dramas.length, 1);
    assert.strictEqual(cat.dramas[0].seriesId, `custom:${validSrc.id}:901`);
    assert.strictEqual(cat.hasMore, true);

    const sr = await sources.searchSource(`custom:${validSrc.id}`, 'Sample', 1);
    assert.strictEqual(sr.length, 1);

    const eps = await sources.fetchEpisodeListUnified(`custom:${validSrc.id}:901`);
    assert.strictEqual(eps.episodes.length, 2);
    assert.strictEqual(eps.episodes[0].vid, `custom:${validSrc.id}:901:0:0`);

    const play = await sources.fetchPlayUrlUnified(eps.episodes[0].vid, eps.series_id);
    assert.strictEqual(play.format, 'hls');
    assert.strictEqual(play.url, 'https://cdn.example.com/1.m3u8');
    assert.strictEqual(play.variants.length, 2, 'collects alternate line URL for fallback');
  } finally {
    axios.get = origGet;
    sources.setCustomSources([]);
  }
});

test('ui_server /api/custom-sources CRUD persists to config.json and updates /api/sources', async () => {
  const os = require('os');
  const http = require('http');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-custom-cms-'));
  const prevCfg = process.env.HDRG_CONFIG_FILE;
  const prevIso = process.env.HDRG_ISOLATED_CONFIG;
  process.env.HDRG_CONFIG_FILE = path.join(tmpDir, 'config.json');
  process.env.HDRG_ISOLATED_CONFIG = '1';

  const jsonReq = (port, method, reqPath, payload = null) => new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  let uiServer = null;
  let started = false;
  try {
    delete require.cache[require.resolve('./ui_server')];
    uiServer = require('./ui_server');
    const info = await uiServer.startServer({ port: 0, host: '127.0.0.1', warmUp: false });
    started = true;

    const bad = await jsonReq(info.port, 'POST', '/api/custom-sources', { name: 'Bad', url: 'http://127.0.0.1/api.php/provide/vod/' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.success, false);

    const added = await jsonReq(info.port, 'POST', '/api/custom-sources', { name: 'MyVod', url: 'https://vod.example.com' });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.json.success, true);
    const createdId = added.json.source.id;

    const listRes = await jsonReq(info.port, 'GET', '/api/custom-sources');
    assert.strictEqual(listRes.json.sources.length, 1);
    assert.strictEqual(listRes.json.sources[0].url, 'https://vod.example.com/api.php/provide/vod/');

    const srcRes = await jsonReq(info.port, 'GET', '/api/sources');
    const ids = srcRes.json.sources.map((s) => s.id);
    assert.ok(ids.includes('dramawave') && ids.includes('netshort') && ids.includes('goodshort'));
    assert.ok(ids.includes(`custom:${createdId}`));

    const savedCfg = JSON.parse(fs.readFileSync(process.env.HDRG_CONFIG_FILE, 'utf8'));
    assert.strictEqual(savedCfg.CUSTOM_SOURCES.length, 1);

    // Batch test + batch import CRUD with TVBox JSON comments, spider skip, SSRF protection, and dedup
    const axios = require('axios');
    const origGet = axios.get;
    try {
      axios.get = async (reqUrl) => {
        const u = new URL(reqUrl);
        if (u.hostname === 'vod.example.com') {
          return {
            data: JSON.stringify({
              code: 1,
              class: [{ type_id: 2, type_name: '连续剧' }],
              list: [{ vod_id: 10, vod_name: 'Existing VOD', vod_pic: 'https://cdn.example.com/10.jpg' }],
            }),
          };
        }
        if (u.hostname === 'short.example.com') {
          return {
            data: JSON.stringify({
              code: 1,
              class: [{ type_id: 21, type_name: '短剧' }],
              list: [{ vod_id: 1, vod_name: 'Short 1', vod_pic: 'https://cdn.example.com/1.jpg' }],
            }),
          };
        }
        if (u.hostname === 'movie.example.com') {
          return {
            data: JSON.stringify({
              code: 1,
              class: [{ type_id: 1, type_name: '电影' }],
              list: [{ vod_id: 2, vod_name: 'Movie 2', vod_pic: 'https://cdn.example.com/2.jpg' }],
            }),
          };
        }
        throw new Error('connect ETIMEDOUT');
      };

      const batchPayload = [
        '// TVBox comment header',
        '{',
        '  "sites": [',
        '    { "key": "dup", "name": "Existing Dup", "type": 0, "api": "https://vod.example.com/api.php/provide/vod/at/xml" },',
        '    { "key": "short", "name": "ShortHub", "type": 1, "api": "https://short.example.com/api.php/provide/vod/" },',
        '    { "key": "mov", "name": "MovieHub", "type": 1, "api": "https://movie.example.com/api.php/provide/vod/" },',
        '    { "key": "dead", "name": "DeadHub", "type": 1, "api": "https://dead.example.com/api.php/provide/vod/" },',
        '    { "key": "spider", "name": "SpiderOnly", "type": 3, "api": "csp_Demo" },',
        '    { "key": "ssrf", "name": "LocalSSRF", "type": 1, "api": "http://127.0.0.1/api.php/provide/vod/" }',
        '  ]',
        '}',
      ].join('\n');

      const btRes = await jsonReq(info.port, 'POST', '/api/custom-sources/batch-test', { input: batchPayload });
      assert.strictEqual(btRes.status, 200);
      assert.strictEqual(btRes.json.summary.total, 4);
      assert.strictEqual(btRes.json.summary.working, 3);
      assert.strictEqual(btRes.json.summary.failed, 1);
      assert.strictEqual(btRes.json.summary.shortDramaCount, 1);
      const dupRow = btRes.json.results.find((r) => r.name === 'Existing Dup');
      assert.strictEqual(dupRow.alreadyAdded, true);
      const shortRow = btRes.json.results.find((r) => r.name === 'ShortHub');
      assert.strictEqual(shortRow.hasShortDrama, true);

      const bSave = await jsonReq(info.port, 'POST', '/api/custom-sources/batch', {
        items: btRes.json.results.filter((r) => r.ok).map((r) => ({ name: r.name, url: r.url })),
      });
      assert.strictEqual(bSave.status, 200);
      assert.strictEqual(bSave.json.addedCount, 2, 'skips already-added dup and imports 2 new working sources');
      assert.strictEqual(bSave.json.skippedCount, 1);
      assert.strictEqual(bSave.json.sources.length, 3);
    } finally {
      axios.get = origGet;
    }

    const delRes = await jsonReq(info.port, 'POST', '/api/custom-sources/delete', { id: createdId });
    assert.strictEqual(delRes.json.success, true);
    assert.strictEqual(delRes.json.sources.length, 2);
  } finally {
    try { if (started && uiServer) uiServer.stopServer(); } catch (_) {}
    try { require('./lib/sources').setCustomSources([]); } catch (_) {}
    if (prevCfg === undefined) delete process.env.HDRG_CONFIG_FILE; else process.env.HDRG_CONFIG_FILE = prevCfg;
    if (prevIso === undefined) delete process.env.HDRG_ISOLATED_CONFIG; else process.env.HDRG_ISOLATED_CONFIG = prevIso;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ytdm YouTube/Dailymotion adapter, lockupViewModel parser, extractVariants ytdlp passthrough, and GoodShort multi-column page 2', async () => {
  const axios = require('axios');
  const ytdm = require('./lib/ytdm');
  const gs = require('./lib/goodshort');
  const sources = require('./lib/sources');
  const dl = require('./lib/downloader');

  // ID & URL resolution
  assert.strictEqual(ytdm.resolveSeriesId('https://www.youtube.com/playlist?list=PLbUFpdWy6Yb9jgJ4R'), 'ytdm:pl:PLbUFpdWy6Yb9jgJ4R');
  assert.strictEqual(ytdm.resolveSeriesId('https://www.youtube.com/watch?v=MircdZfJOlw&list=PLbUFpdWy6Yb9jgJ4R'), 'ytdm:v:MircdZfJOlw');
  assert.strictEqual(ytdm.resolveSeriesId('https://youtu.be/MircdZfJOlw'), 'ytdm:v:MircdZfJOlw');
  assert.strictEqual(ytdm.resolveSeriesId('https://www.dailymotion.com/video/x2gh6ox'), 'ytdm:dm:x2gh6ox');
  assert.throws(() => ytdm.resolveSeriesId('https://evil.example.com/watch?v=12345678'), /YouTube/);

  // sources routing preserves social tab URL separation while resolving ytdm: IDs and explicit ytdm URLs
  assert.strictEqual(sources.detectSourceFromId('ytdm:pl:PLbUFpdWy6Yb9jgJ4R'), 'ytdm');
  assert.strictEqual(sources.resolveDramaUrlOrId('ytdm:dm:x2gh6ox'), 'ytdm:dm:x2gh6ox');
  assert.strictEqual(sources.resolveDramaUrlOrId('https://www.youtube.com/watch?v=MircdZfJOlw'), null);
  assert.strictEqual(sources.resolveYtdmUrl('https://www.youtube.com/playlist?list=PLbUFpdWy6Yb9jgJ4R'), 'ytdm:pl:PLbUFpdWy6Yb9jgJ4R');
  assert.ok(sources.getSourcesList().some((s) => s.id === 'ytdm'));

  // extractYoutubeItems parses both lockupViewModel playlist and videoRenderer while filtering short clips
  const sampleYtData = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{
              itemSectionRenderer: {
                contents: [
                  {
                    lockupViewModel: {
                      contentId: 'PLbUFpdWy6Yb9jgJ4R',
                      contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
                      metadata: { lockupMetadataViewModel: { title: { content: 'Khmer Drama Series' } } },
                      contentImage: {
                        collectionThumbnailViewModel: {
                          primaryThumbnail: {
                            thumbnailViewModel: {
                              image: { sources: [{ url: 'https://i.ytimg.com/vi/MircdZfJOlw/hq720.jpg' }] },
                              overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '42 videos' } }] } }],
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    videoRenderer: {
                      videoId: 'ShortClip111',
                      title: { simpleText: 'Short Trailer' },
                      lengthText: { simpleText: '0:45' },
                      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/ShortClip111/hqdefault.jpg' }] },
                    },
                  },
                  {
                    videoRenderer: {
                      videoId: 'FullDrama999',
                      title: { runs: [{ text: 'Full Khmer Drama Movie' }] },
                      lengthText: { simpleText: '1:15:00' },
                      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/FullDrama999/hqdefault.jpg' }] },
                    },
                  },
                ],
              },
            }],
          },
        },
      },
    },
  };
  const fakeHtml = `<script>var ytInitialData = ${JSON.stringify(sampleYtData)};</script>`;
  const parsedCards = ytdm.extractYoutubeItems(fakeHtml, { minDurationSec: 240 });
  assert.strictEqual(parsedCards.length, 2);
  assert.strictEqual(parsedCards[0].series_id, 'ytdm:pl:PLbUFpdWy6Yb9jgJ4R');
  assert.strictEqual(parsedCards[0].episode_count, 42);
  assert.strictEqual(parsedCards[1].series_id, 'ytdm:v:FullDrama999');

  // Play info & downloader extractVariants ytdlp passthrough
  const playRes = await ytdm.fetchPlayUrlSingle('ytdm:v:FullDrama999', 'ytdm:pl:PLbUFpdWy6Yb9jgJ4R');
  assert.strictEqual(playRes.isYtdlp, true);
  assert.strictEqual(playRes.ytdlpUrl, 'https://www.youtube.com/watch?v=FullDrama999');
  const vars = dl.extractVariants(playRes, 'fast');
  assert.strictEqual(vars[0].isYtdlp, true);
  assert.strictEqual(vars[0].ytdlpUrl, 'https://www.youtube.com/watch?v=FullDrama999');
  const mismatch = await ytdm.fetchPlayUrlSingle('ytdm:v:FullDrama999', 'ytdm:v:OtherVideo1');
  assert.strictEqual(mismatch.url, null);

  // GoodShort page 2 advances across columns when column 1 is empty
  const origPost = axios.post;
  try {
    axios.post = async (reqUrl, body) => {
      if (String(reqUrl).endsWith('/home/index')) {
        return {
          data: {
            status: 0,
            data: {
              pageColumns: [
                {
                  style: 'NORMAL',
                  name: 'Col A',
                  columnResourceUrl: 'Col-A',
                  items: [{ bookId: 100001, bookName: 'Drama A', cover: 'https://cdn.example.com/a.jpg', chapterCount: 20 }],
                },
                {
                  style: 'NORMAL',
                  name: 'Col B',
                  columnResourceUrl: 'Col-B',
                  items: [{ bookId: 100002, bookName: 'Drama B', cover: 'https://cdn.example.com/b.jpg', chapterCount: 30 }],
                },
              ],
            },
          },
        };
      }
      if (body.columnResourceUrl === 'Col-A') {
        return { data: { status: 0, data: { items: [], totalSize: 0, more: false } } };
      }
      return {
        data: {
          status: 0,
          data: {
            items: [{ bookId: 100003, bookName: 'Drama C', cover: 'https://cdn.example.com/c.jpg', chapterCount: 40 }],
            totalSize: 10,
            more: false,
          },
        },
      };
    };
    const g1 = await gs.browseList({ genre: '', page: 1 });
    assert.strictEqual(g1.results.length, 2);
    const g2 = await gs.browseList({ genre: '', page: 2 });
    assert.strictEqual(g2.results.length, 1);
    assert.strictEqual(g2.results[0].series_id, 'goodshort:100003');
  } finally {
    axios.post = origPost;
  }

  // ytdm includes Official K-Drama and India Bollywood/Khmer genres cleanly
  const origGet = axios.get;
  try {
    axios.get = async (reqUrl) => {
      if (String(reqUrl).includes('dailymotion.com')) return { data: { list: [] } };
      return { data: fakeHtml };
    };
    const kdOff = await ytdm.browseList({ genre: 'kdrama_official', page: 1 });
    assert.strictEqual(kdOff.success, true);
    assert.ok(kdOff.genres.some((g) => g.slug === 'kdrama_official'));
    assert.ok(kdOff.genres.some((g) => g.slug === 'india'));
    assert.strictEqual(kdOff.results.length, 2);
    const indRes = await ytdm.browseList({ genre: 'india', page: 1 });
    assert.strictEqual(indRes.success, true);
    assert.strictEqual(indRes.results.length, 2);
  } finally {
    axios.get = origGet;
  }
});

test('downloader probeMediaProfile duration, buildNormalizeEncodeArgs copyVideo/faststart, and parallel mergeEpisodesToMovie', async () => {
  const dl = require('./lib/downloader');

  // Verify buildNormalizeEncodeArgs behavior
  const copyArgs = dl.buildNormalizeEncodeArgs('in.mp4', 'out.mp4', 1080, 1920, 'h264_nvenc', {
    copyVideo: true,
    faststart: false,
    compressed: false,
  });
  assert.ok(copyArgs.includes('-c:v') && copyArgs[copyArgs.indexOf('-c:v') + 1] === 'copy');
  assert.ok(!copyArgs.includes('-vf'), 'skips scale filter when copyVideo is true');
  assert.ok(!copyArgs.includes('+faststart'), 'omits +faststart on intermediate temp clips');

  const encArgs = dl.buildNormalizeEncodeArgs('in.mp4', 'out.mp4', 720, 1280, null, {
    copyVideo: false,
    faststart: true,
    compressed: true,
    cpuThreads: 2,
  });
  assert.ok(encArgs.includes('libx264'));
  assert.ok(encArgs.includes('-threads') && encArgs[encArgs.indexOf('-threads') + 1] === '2');
  assert.ok(encArgs.includes('+faststart'));

  // Verify copyAudio, CUDA pipeline, hevc_nvenc, and pickDominantTarget smart codec/720p cap
  const cudaArgs = dl.buildNormalizeEncodeArgs('in.mp4', 'out.mp4', 720, 1280, 'hevc_nvenc', {
    copyVideo: false,
    copyAudio: true,
    hasAudio: true,
    needAudioTrack: true,
    compressed: true,
    useCudaPipeline: true,
    useScaleCuda: true,
  });
  assert.ok(cudaArgs.includes('-hwaccel') && cudaArgs.includes('cuda'));
  assert.ok(cudaArgs.includes('scale_cuda=720:1280'));
  assert.ok(cudaArgs.includes('hevc_nvenc') && cudaArgs.includes('hvc1'));
  assert.ok(cudaArgs.includes('-c:a') && cudaArgs[cudaArgs.indexOf('-c:a') + 1] === 'copy');

  const mixedHevcProfiles = [
    ...Array.from({ length: 18 }, () => ({ sig: 'hevcx1080x1920|aacx44100x2', vCodec: 'hevc', w: 1080, h: 1920, hasAudio: true, aCodec: 'aac', ar: 44100, ch: 2 })),
    { sig: 'hevcx1080x1924|aacx44100x2', vCodec: 'hevc', w: 1080, h: 1924, hasAudio: true, aCodec: 'aac', ar: 44100, ch: 2 },
    { sig: 'h264x576x1024|aacx44100x2', vCodec: 'h264', w: 576, h: 1024, hasAudio: true, aCodec: 'aac', ar: 44100, ch: 2 },
  ];
  const normTgt = dl.pickDominantTarget(mixedHevcProfiles, { gpuCaps: { hevcEncoder: 'hevc_nvenc' }, hasLibx265: true, compressed: false });
  assert.strictEqual(normTgt.vCodec, 'hevc', 'keeps dominant hevc codec so 18 clips skip re-encode');
  assert.strictEqual(normTgt.w, 1080);
  assert.strictEqual(normTgt.h, 1920);
  const compTgt = dl.pickDominantTarget(mixedHevcProfiles, { gpuCaps: { hevcEncoder: 'hevc_nvenc' }, hasLibx265: true, compressed: true });
  assert.strictEqual(compTgt.w, 720, 'compress mode caps 1080x1920 down to 720x1280');
  assert.strictEqual(compTgt.h, 1280);

  if (!fs.existsSync(dl.FFMPEG_EXE) || !fs.existsSync(dl.FFPROBE_EXE)) return;

  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-merge-test-'));
  try {
    const clipA = path.join(tmp, 'EP001.mp4');
    const clipB = path.join(tmp, 'EP002.mp4');
    const mkClip = (dst, sr) => spawnSync(dl.FFMPEG_EXE, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=1',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sr}:d=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', dst,
    ]);
    mkClip(clipA, 44100);
    mkClip(clipB, 48000);

    const prof = await dl.probeMediaProfile(clipA);
    assert.strictEqual(prof.w, 360);
    assert.ok(prof.duration > 0.3, 'probeMediaProfile returns duration in single pass');

    // Mismatched audio sample rates (44100 vs 48000) merge cleanly via copyVideo normalization
    const directRes = await dl.mergeEpisodesToMovie(tmp, 'TestMergeDirect', [
      { epNum: 1, file: clipA },
      { epNum: 2, file: clipB },
    ], { compress: false });
    assert.strictEqual(directRes.count, 2);
    assert.ok(dl.isValidMp4File(directRes.path));

    // Swapped stream order ([0:audio, 1:video]) + mismatched timescale must merge WITHOUT putting video frames in audio!
    const clipSwapped = path.join(tmp, 'EP003.mp4');
    spawnSync(dl.FFMPEG_EXE, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=44100:d=1',
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=1',
      '-map', '0:a:0', '-map', '1:v:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-video_track_timescale', '90000',
      '-c:a', 'aac', '-shortest', clipSwapped,
    ]);
    const swappedProf = await dl.probeMediaProfile(clipSwapped);
    assert.strictEqual(swappedProf.streamOrderOk, false, 'Must detect [0:audio, 1:video] swapped stream order');
    const swappedRes = await dl.mergeEpisodesToMovie(tmp, 'TestMergeSwapped', [
      { epNum: 1, file: clipA },
      { epNum: 2, file: clipSwapped },
    ], { compress: false });
    const mergedSwappedProf = await dl.probeMediaProfile(swappedRes.path);
    assert.strictEqual(mergedSwappedProf.streamOrderOk, true, 'Merged output must restore [0:video, 1:audio]');
    assert.ok(mergedSwappedProf.aDuration >= 1.7 && mergedSwappedProf.vDuration >= 1.7, `Expected full ~2s A/V duration, got v=${mergedSwappedProf.vDuration}, a=${mergedSwappedProf.aDuration}`);
    assert.strictEqual(dl.validateMergedMovieProfile(mergedSwappedProf, [prof, swappedProf], true).ok, true);

    // Parallel compress merge produces valid MP4 with progress events
    const logs = [];
    const compRes = await dl.mergeEpisodesToMovie(tmp, 'TestMergeComp', [
      { epNum: 1, file: clipA },
      { epNum: 2, file: clipB },
    ], { compress: true, onProgress: (pct, msg) => logs.push(msg) });
    assert.strictEqual(compRes.count, 2);
    assert.ok(dl.isValidMp4File(compRes.path));
    assert.ok(logs.some((m) => m.includes('បង្ហាប់')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tech-radar filters unsafe keywords, builds safe open-source digest, and formats bounded Telegram HTML', async () => {
  const radar = require('./lib/tech-radar');

  assert.strictEqual(radar.isSafeOpenSourceItem({ fullName: 'dev/yt-dlp-helper', description: 'FFmpeg & HLS GUI tool' }), true);
  assert.strictEqual(radar.isSafeOpenSourceItem({ fullName: 'bad/app-crack', description: 'License bypass tool' }), false);
  assert.strictEqual(radar.isSafeOpenSourceItem({ title: 'Keygen & hack utility' }), false);

  const mockReq = async (url) => {
    if (url.includes('/releases/latest')) {
      return {
        status: 200,
        json: {
          tag_name: '2026.11.21',
          name: 'Release 2026.11.21',
          html_url: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.21',
          published_at: new Date().toISOString(),
        },
      };
    }
    if (url.includes('api.github.com/search/repositories')) {
      return {
        status: 200,
        json: {
          items: [
            { full_name: 'oss/ffmpeg-turbo', html_url: 'https://github.com/oss/ffmpeg-turbo', stargazers_count: 120, description: 'Fast <GPU> FFmpeg pipeline & HLS muxer', topics: ['ffmpeg'] },
            { full_name: 'bad/tool-bypass', html_url: 'https://github.com/bad/tool-bypass', stargazers_count: 999, description: 'VIP bypass hack script', topics: [] },
          ],
        },
      };
    }
    if (url.includes('viblo.asia/api/posts')) {
      return {
        status: 200,
        json: {
          data: [
            { title: 'Toi uu Node.js & FFmpeg stream <fast>', slug: 'abc123', url: 'https://viblo.asia/p/abc123', tags: { data: [{ name: 'Node.js' }] } },
            { title: 'Huong dan crack phan mem', slug: 'bad1', url: 'https://viblo.asia/p/bad1', tags: { data: [] } },
          ],
        },
      };
    }
    return { status: 404, json: null };
  };

  const digest = await radar.buildDailyTechDigest({
    requestFn: mockReq,
    seenKeys: new Set(['repo:already/seen']),
  });
  assert.ok(digest.mediaRepos.some((r) => r.fullName === 'oss/ffmpeg-turbo'));
  assert.ok(!digest.mediaRepos.some((r) => r.fullName === 'bad/tool-bypass'), 'unsafe repo excluded');
  assert.strictEqual(digest.vibloPosts.length, 1);
  assert.strictEqual(digest.vibloPosts[0].key, 'viblo:abc123');

  const msgs = radar.formatTelegramDigestMessages(digest, { maxLen: 3800 });
  assert.ok(msgs.length >= 1);
  assert.ok(msgs.every((m) => m.length <= 3800));
  assert.ok(msgs[0].includes('&lt;GPU&gt;') && msgs[0].includes('&lt;fast&gt;'), 'escapes HTML tags safely');
});

test('getDownloadDir falls back cleanly when folder mkdir/write hits EPERM (Controlled Folder Access)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-dl-perm-'));
  const origEnv = { ...process.env };
  const origMkdirSync = fs.mkdirSync;
  const blockedDir = path.join(tmpDir, 'ProtectedVideos');

  process.env.EZA_PACKAGED_CLIENT = '1';
  process.env.EZA_REQUIRE_CLOUD_LICENSE = '0';
  process.env.HDRG_ISOLATED = '1';
  process.env.EZA_USER_DATA_DIR = tmpDir;
  process.env.HDRG_CONFIG_FILE = path.join(tmpDir, 'config.json');
  process.env.EZA_DEFAULT_DOWNLOAD_DIR = path.join(tmpDir, 'SafeDownloads');
  fs.writeFileSync(process.env.HDRG_CONFIG_FILE, JSON.stringify({ DOWNLOAD_DIR: blockedDir }), 'utf8');

  let blockedAttempts = 0;
  fs.mkdirSync = (targetPath, opts) => {
    if (path.normalize(String(targetPath)) === path.normalize(blockedDir)) {
      blockedAttempts += 1;
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return origMkdirSync.call(fs, targetPath, opts);
  };

  try {
    delete require.cache[require.resolve('./ui_server')];
    const uiServer = require('./ui_server');
    const resolved1 = uiServer.getDownloadDir();
    const resolved2 = uiServer.getDownloadDir();
    assert.equal(resolved1, path.normalize(process.env.EZA_DEFAULT_DOWNLOAD_DIR));
    assert.equal(resolved2, resolved1);
    assert.equal(blockedAttempts, 1, 'blocked protected path should be cached and checked only once');
  } finally {
    fs.mkdirSync = origMkdirSync;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cleanDist keeps only current version x64 installer and removes old/portable/unpacked files', () => {
  const { cleanDist } = require('./scripts/clean-dist');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-clean-dist-'));
  const distDir = path.join(tmpDir, 'dist');
  try {
    fs.mkdirSync(path.join(distDir, 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      productName: 'EZA PRO Downloader',
      version: '1.2.0',
    }), 'utf8');
    fs.writeFileSync(path.join(distDir, 'win-unpacked', 'dummy.txt'), 'x');
    fs.writeFileSync(path.join(distDir, 'EZA PRO Downloader-1.2.0-x64.exe'), 'installer-bytes');
    fs.writeFileSync(path.join(distDir, 'EZA PRO Downloader-1.1.1-x64.exe'), 'old');
    fs.writeFileSync(path.join(distDir, 'EZA PRO Downloader-1.2.0-Portable.exe'), 'portable');
    fs.writeFileSync(path.join(distDir, 'EZA PRO Downloader-1.2.0-x64.exe.blockmap'), 'map');
    fs.writeFileSync(path.join(distDir, 'latest.yml'), 'yml');
    fs.writeFileSync(path.join(distDir, 'builder-debug.yml'), 'dbg');

    const res = cleanDist(tmpDir);
    assert.equal(res.targetExe, 'EZA PRO Downloader-1.2.0-x64.exe');
    assert.deepEqual(fs.readdirSync(distDir), ['EZA PRO Downloader-1.2.0-x64.exe']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
