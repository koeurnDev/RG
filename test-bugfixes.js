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
