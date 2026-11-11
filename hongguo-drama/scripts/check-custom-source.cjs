// Offline MacCMS fixtures; no user data, credentials, DNS or media downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const sourcePath = path.resolve(__dirname, '../src/native/custom-source.js');
const req = createRequire(sourcePath);
const id = '12345678-1234-4234-9234-123456789abc';
const source = `custom:${id}`, sid = `${source}:12`;
const config = { id, name: '测试片库', url: 'https://api.example/api.php/provide/vod/', enabled: true };
function fixture() {
  assert.ok(fs.existsSync(sourcePath), 'custom-source provider must exist');
  const state = { sources: [{ ...config }], calls: [], address: '93.184.216.34', redirect: '', failure: null,
    body: { code: 1, page: 1, pagecount: 2, total: 3, class: [{ type_id: 2, type_name: '短剧' }], list: [{
      vod_id: 12, vod_name: '<b>测试剧</b>', vod_pic: 'https://images.example/cover.jpg', type_name: '短剧',
      vod_play_from: '解析$$$线路甲$$$线路乙',
      vod_play_url: '第1集$https://parser.example/?url=x.mp4$$$第1集$https://cdn.example/one.mp4#第2集$https://cdn.example/two.m3u8$$$01$https://backup.example/one.m3u8#02$https://backup.example/two.mp4',
    }] } };
  const guardContext = { module: { exports: {} }, URL, require: name => name === 'node:dns'
    ? { lookup: (_host, _options, callback) => callback(null, [{ address: state.address, family: 4 }]) } : req(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/native/web-media-guard.js'), 'utf8'), guardContext);
  const context = { module: { exports: {} }, URL, AbortController, Buffer, setTimeout, clearTimeout,
    require: name => name === '../store' ? { getSettings: () => ({ custom_sources: state.sources }) }
      : name === './web-media-guard' ? guardContext.module.exports : name === 'axios' ? { get: async (url, options) => {
        state.calls.push({ url, options });
        assert.equal(options.proxy, undefined, 'preserve the application proxy environment instead of forcing direct access');
        await new Promise((resolve, reject) => options.lookup(new URL(url).hostname, { all: true }, error => error ? reject(error) : resolve()));
        if (state.redirect) options.beforeRedirect({}, { headers: { location: state.redirect } }, { url });
        if (state.failure) throw state.failure;
        if (state.onRequest) await state.onRequest(options);
        return { data: typeof state.body === 'string' ? state.body : JSON.stringify(state.body) };
      } } : req(name) };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { provider: context.module.exports, state };
}

test('validates public JSON endpoints and configuration identity before any network', () => {
  const { provider, state } = fixture();
  assert.equal(provider.validateSource({ name: '片库', url: 'https://api.example' }).url, config.url);
  for (const url of ['file:///tmp/a', 'http://127.0.0.1/api', 'http://10.2.3.4/api', 'http://[::1]/', 'http://localhost/', 'https://u:p@api.example/', 'javascript:alert(1)']) {
    assert.throws(() => provider.validateSource({ ...config, url }));
  }
  assert.throws(() => provider.validateSource({ ...config, id: '../bad' }));
  assert.equal(state.calls.length, 0);
});

test('catalog/search use MacCMS parameters, stable prefixed ids and categories', async () => {
  const { provider, state } = fixture();
  const catalog = await provider.fetchCatalog({ source, genre: '2', page: 1 });
  assert.equal(catalog.success, true);
  assert.equal(catalog.results[0].series_id, sid);
  assert.equal(catalog.results[0].series_title, '测试剧');
  assert.equal(catalog.genres[0].slug, '2');
  assert.equal(catalog.hasMore, true);
  assert.equal(new URL(state.calls.at(-1).url).searchParams.get('t'), '2');
  const search = await provider.searchSeries('故事', { source });
  assert.equal(search.success, true);
  assert.equal(new URL(state.calls.at(-1).url).searchParams.get('wd'), '故事');
  assert.equal(new URL(state.calls.at(-1).url).searchParams.get('ac'), 'detail');
  const count = state.calls.length;
  assert.equal((await provider.fetchCatalog({ source, page: -1 })).success, false);
  assert.equal(state.calls.length, count);
});

test('detail groups direct media lines once; playback candidates keep individual URLs and formats', async () => {
  const { provider, state } = fixture();
  const detail = await provider.fetchEpisodeList(sid);
  assert.equal(detail.episodes.length, 2, 'alternate lines must not duplicate episode list');
  assert.equal(detail.episodes[0].title, '第1集');
  assert.equal(detail.episodes[0].vid, `${sid}:1:0`);
  assert.ok(!JSON.stringify(detail).includes('cdn.example'), 'do not send playable credentials with list rows');
  const play = await provider.fetchPlayUrlSingle(detail.episodes[0].vid, sid);
  assert.equal(play.url, 'https://cdn.example/one.mp4');
  assert.equal(play.format, 'mp4');
  assert.equal(play.source, 'custom');
  assert.equal(play.candidates.length, 2);
  assert.equal(play.candidates[1].url, 'https://backup.example/one.m3u8');
  assert.equal(play.candidates[1].format, 'hls');
  assert.ok(play.candidates.every(item => !item.contentKey && !item.spadeA));
  assert.equal(new URL(state.calls.at(-1).url).searchParams.get('ids'), '12');
});

test('identities and permission flags are rechecked without cached authorization', async () => {
  const { provider, state } = fixture();
  const vid = `${sid}:1:0`;
  for (const wrong of [`${source}:999`, 'hema:12']) assert.equal((await provider.fetchPlayUrlSingle(vid, wrong)).url, null);
  assert.equal(state.calls.length, 0);
  state.body.list[0].vod_id = 999;
  await assert.rejects(provider.fetchEpisodeList(sid), /不一致/);
  state.body.list[0].vod_id = 12;
  assert.ok((await provider.fetchPlayUrlSingle(vid, sid)).url);
  for (const flag of [{ vod_points_play: 5 }, { vod_pwd_play: 'private' }, { locked: true }]) {
    Object.assign(state.body.list[0], flag);
    assert.equal((await provider.fetchPlayUrlSingle(vid, sid)).locked, true);
    for (const key of Object.keys(flag)) delete state.body.list[0][key];
  }
  assert.equal((await provider.fetchPlayUrlSingle(`${sid}:0:0`, sid)).url, null, 'parser line is never a media candidate');
});

test('disabled, deleted and changed sources stop requests including an in-flight redirect', async () => {
  const { provider, state } = fixture();
  await provider.fetchCatalog({ source });
  state.sources[0].enabled = false;
  const count = state.calls.length;
  assert.equal((await provider.fetchCatalog({ source })).success, false);
  assert.equal((await provider.fetchPlayUrlSingle(`${sid}:1:0`, sid)).url, null);
  assert.equal(state.calls.length, count);
  state.sources = [];
  assert.throws(() => provider.assertEnabled(source));
  state.sources = [{ ...config }];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  state.onRequest = options => new Promise((resolve, reject) => {
    entered();
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const request = provider.fetchCatalog({ source });
  await started;
  state.sources[0].enabled = false;
  provider.cancelRequests(id);
  assert.equal((await request).success, false);
});

test('private DNS/redirects, non-JSON, wrong schema and raw error secrets never become valid sources', async () => {
  const { provider, state } = fixture();
  state.address = '192.168.1.3';
  assert.equal((await provider.fetchCatalog({ source })).success, false);
  state.address = '93.184.216.34'; state.redirect = 'http://127.0.0.1/admin';
  assert.equal((await provider.fetchCatalog({ source })).success, false);
  state.redirect = '';
  for (const body of ['<script>evil()</script>', { code: 1 }, { code: 0, msg: 'secret' }, null]) {
    state.body = body;
    const result = await provider.fetchCatalog({ source });
    assert.equal(result.success, false);
    assert.ok(!result.error.includes('secret'));
  }
  state.failure = new Error('https://api.example/?token=secret');
  assert.ok(!(await provider.fetchCatalog({ source })).error.includes('secret'));
});

test('source probe can validate an unsaved draft without persisting configuration', async () => {
  const { provider, state } = fixture();
  state.sources = [];
  const result = await provider.testCustomSource(config);
  assert.equal(result.success, true);
  assert.equal(state.sources.length, 0);
});

test('requests retain the existing proxy configuration and allow its local socket lookup', async () => {
  const { provider, state } = fixture();
  assert.equal((await provider.fetchCatalog({ source })).success, true);
  const options = state.calls.at(-1).options;
  assert.equal(Object.hasOwn(options, 'proxy'), false);
  state.address = '127.0.0.1';
  const addresses = await new Promise((resolve, reject) => options.lookup('configured-proxy.local', { all: true },
    (error, result) => error ? reject(error) : resolve(result)));
  assert.equal(addresses[0].address, '127.0.0.1', 'user-selected local proxy is trusted; target DNS belongs to that proxy');
});

test('hongguo routes custom identities without built-in cache or source fallback', async () => {
  const mainSource = path.resolve(__dirname, '../src/native/hongguo.js');
  const mainRequire = createRequire(mainSource), calls = [];
  const context = { module: { exports: {} }, URL, Buffer, AbortController, setTimeout, clearTimeout, process: { env: {} },
    require: name => name === './custom-source' ? {
      fetchEpisodeList: async value => { calls.push(['detail', value]); return { series_id: value }; },
      fetchPlayUrlSingle: async (vid, value, options) => { calls.push(['play', vid, value, options]); return { url: 'https://cdn.example/one.mp4', source: 'custom' }; },
      assertEnabled: () => ({ ...config }),
    } : name === 'axios' ? { get: async () => { throw new Error('must not call a built-in API'); } } : mainRequire(name) };
  vm.runInNewContext(fs.readFileSync(mainSource, 'utf8'), context, { filename: mainSource });
  const api = context.module.exports;
  assert.equal(await api.resolveSeriesId(sid), sid);
  assert.equal((await api.fetchEpisodeList(sid)).series_id, sid);
  assert.equal((await api.fetchEpisodeList(sid)).series_id, sid);
  assert.equal(calls.filter(call => call[0] === 'detail').length, 2, 'custom authorization must never use built-in episode cache');
  assert.equal((await api.fetchPlayUrlSingle(`${sid}:1:0`, sid, { quality: '720p' })).source, 'custom');
  assert.equal(calls.at(-1)[3].quality, '720p');
});
