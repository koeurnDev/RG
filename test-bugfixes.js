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
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => [c.method, c.host, c.pathname]),
    [
      ['POST', 'api5-normal-sinfonlineb.fqnovel.com', '/novel/player/multi_video_model/player/v1'],
      ['POST', 'api5-normal-sinfonlinea.fqnovel.com', '/novel/player/multi_video_model/player/v1'],
      ['GET', 'api5-normal-sinfonlineb.fqnovel.com', '/reading/bookapi/video_tab/multi_video_model/v1/'],
    ]
  );
  assert.equal(calls[2].data, null);
  assert.equal(calls[2].headers['x-ss-stub'], undefined);
  assert.equal(calls[2].headers['Content-Type'], undefined);
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
});
