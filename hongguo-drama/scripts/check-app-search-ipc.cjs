// Offline App-search wiring: opt-in, website fallback, and channel-pinned pagination.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);

const unexpectedSearch = async () => { throw new Error('Unexpected search provider call'); };

function load({ appEnabled = true, appSearch = unexpectedSearch, webSearch = unexpectedSearch,
  newReleaseSearch = async () => [], newReleaseDetailed = null, hemaSearch = unexpectedSearch, xifanSearch = unexpectedSearch,
  customSearch = unexpectedSearch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-app-search-'));
  const handlers = {}, app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {}, hasSwitch: () => false },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }),
  });
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} } };
  const overrides = {
    electron,
    './src/store': { getSettings: () => ({ search_app_enabled: appEnabled }) },
    './src/native/hongguo-search': { searchHongguo: webSearch },
    './src/native/hongguo-app-search': { searchApp: appSearch },
    './src/native/hongguo-app-new': {
      searchNewReleases: newReleaseSearch,
      searchNewReleasesDetailed: newReleaseDetailed || (async (...args) => {
        const results = await newReleaseSearch(...args);
        return Array.isArray(results) ? { results, partial: false } : results;
      }),
    },
    './src/native/hongguo': { fetchEpisodeList: async () => ({ episodes: [] }) },
    './src/native/hema': { search: hemaSearch },
    './src/native/xifan': { search: xifanSearch },
    './src/native/custom-source': { searchSeries: customSearch },
  };
  const context = vm.createContext({ require: name => overrides[name] || req(name), __dirname: path.dirname(source), process,
    console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return { handlers, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  const calls = [];
  const appSearch = async (keyword, options) => {
    calls.push({ keyword, options });
    return { success: true, channel: 'app', page: options.page || 1, hasMore: options.page !== 2,
      cursor: { search_id: 'sid', passback: 'pb', next_offset: 20 },
      results: [{ series_id: options.page === 2 ? '2000002' : '2000001', series_title: `${keyword}${options.page === 2 ? '第二页' : ''}` }] };
  };
  let webCalls = 0;
  const h = load({ appSearch, webSearch: async () => { webCalls++; return { results: [], total: 0, page: 1, totalPages: 1, hasMore: false }; } });
  const first = await h.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(first.success, true);
  assert.equal(first.channel, 'app');
  assert.equal(first.via, 'app');
  assert.equal(webCalls, 0, 'enabled App search must be tried first');
  const more = await h.handlers['search-series-more']({}, '测试剧', { source: 'hongguo', channel: 'app', page: 2, cursor: first.cursor });
  assert.equal(more.success, true);
  assert.equal(more.results[0].series_id, '2000002');
  assert.equal(calls.at(-1).options.page, 2);
  assert.deepEqual(calls.at(-1).options.cursor, { search_id: 'sid', passback: 'pb', next_offset: 20 });
  h.cleanup();

  const h2 = load({
    appSearch: async () => { throw Object.assign(new Error('app down'), { code: 'APP_EMPTY' }); },
    webSearch: async () => ({ results: [{ series_id: '3000001', series_title: '官网结果' }], total: 1, page: 1, totalPages: 1, hasMore: true }),
  });
  const fallback = await h2.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(fallback.success, true);
  assert.equal(fallback.channel, 'web');
  assert.equal(fallback.results[0].series_title, '官网结果');
  assert.match(fallback.appError, /app down/);
  h2.cleanup();

  const h3 = load({ appEnabled: false, appSearch: async () => { throw new Error('must not run'); }, webSearch: async () => ({ results: [{ series_id: '4000001', series_title: '官网' }], total: 1, page: 1, totalPages: 1, hasMore: false }) });
  const disabled = await h3.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(disabled.channel, 'web');
  h3.cleanup();

  for (const status of [503, 502]) {
    let webRequests = 0;
    const appRequests = [];
    const fixture = load({
      appEnabled: false,
      webSearch: async () => { webRequests++; throw Object.assign(new Error(`搜索服务暂不可用（HTTP ${status}）`), { kind: 'upstream' }); },
      appSearch: async (keyword, options) => {
        appRequests.push(options);
        return { success: true, channel: 'app', page: options.page, hasMore: options.page === 1,
          cursor: { search_id: 'fallback-search', next_offset: 20 }, results: [{ series_id: '8000001', series_title: keyword }] };
      },
    });
    try {
      const first = await fixture.handlers['search-series']({}, '接班', { source: 'hongguo' });
      assert.equal(first.success, true, `HTTP ${status} must automatically recover through App search`);
      assert.equal(first.channel, 'app'); assert.equal(first.partial, true);
      assert.match(first.apiError, new RegExp(String(status)));
      const beforeMore = { webRequests, appRequests: appRequests.length };
      const more = await fixture.handlers['search-series-more']({}, '接班', { source: 'hongguo', channel: first.channel, page: 2, cursor: first.cursor });
      assert.equal(more.success, true); assert.equal(webRequests, beforeMore.webRequests);
      assert.equal(appRequests.length, beforeMore.appRequests + 1); assert.equal(appRequests.at(-1).page, 2);
      assert.equal(appRequests.at(-1).cursor.search_id, 'fallback-search');
    } finally { fixture.cleanup(); }
  }

  {
    let appRequests = 0;
    const fixture = load({
      appSearch: async keyword => { appRequests++; return { success: true, channel: 'app', results: keyword === '缺席第一季' ? [] : [{ series_id: '8000002', series_title: keyword }], hasMore: false }; },
      webSearch: async keyword => ({ results: [{ series_id: '8000003', series_title: keyword }], page: 1, hasMore: false }),
    });
    try {
      await fixture.handlers['search-series']({}, '缺席第一季', { source: 'hongguo' });
      const second = await fixture.handlers['search-series']({}, '接班第一季', { source: 'hongguo' });
      assert.equal(second.channel, 'app', 'a valid empty result must not disable App search for other keywords');
      assert.equal(appRequests, 2);
    } finally { fixture.cleanup(); }
  }

  {
    const calls = [];
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6000001', series_title: '无关结果' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async (keyword, options) => {
        calls.push({ keyword, options });
        return [{ series_id: '6000002', series_title: '当天新剧', new_release: true, released_today: true, source: 'hongguo' }];
      },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '当天新剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.channel, 'web');
      assert.equal(result.meta.newRelease, 1);
      assert.equal(result.meta.newReleaseChecked, true);
      assert.ok(result.results.some(item => item.series_id === '6000002' && item.new_release && item.released_today));
      assert.equal(calls.length, 1, 'website miss must consult the App new-release list once');
      assert.equal(calls[0].keyword, '当天新剧');
    } finally { fixture.cleanup(); }
  }

  {
    const started = Date.now();
    let webDeadline = 0, newReleaseDeadline = 0;
    const fixture = load({
      appEnabled: false,
      webSearch: async (_keyword, options) => {
        webDeadline = options.deadline;
        return { results: [], total: 0, page: 1, totalPages: 1, hasMore: false };
      },
      newReleaseSearch: async (_keyword, options) => {
        newReleaseDeadline = options.deadline;
        return [];
      },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '当天新剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.ok(webDeadline > started && webDeadline - started <= 12500,
        'official search must stop before the full 20s search budget');
      assert.ok(newReleaseDeadline - started >= 7000 && newReleaseDeadline - started <= 8500,
        'new-release lookup must keep its own usable request budget');
    } finally { fixture.cleanup(); }
  }

  {
    const started = Date.now();
    let newReleaseDeadline = 0;
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6060001', series_title: '当天新剧加长版' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async (_keyword, options) => {
        newReleaseDeadline = options.deadline;
        return [];
      },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '当天新剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.ok(newReleaseDeadline - started <= 3000,
        'a usable website result must not block on the full App supplement budget');
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [], total: 0, page: 1, totalPages: 1, hasMore: false }),
      newReleaseDetailed: async () => ({ results: [], partial: true }),
    });
    try {
      const result = await fixture.handlers['search-series']({}, '当天新剧', { source: 'hongguo' });
      assert.equal(result.success, false, 'an incomplete new-release scan must not look like a confirmed empty result');
      assert.equal(result.partial, true);
      assert.match(result.error, /部分分类/);
    } finally { fixture.cleanup(); }
  }

  {
    let calls = 0;
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [], total: 0, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async () => { calls++; return []; },
    });
    try {
      await fixture.handlers['search-series']({}, '没有结果一', { source: 'hongguo' });
      await fixture.handlers['search-series']({}, '没有结果二', { source: 'hongguo' });
      assert.equal(calls, 2, 'a complete empty scan must not trigger a false cooldown');
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6050001', series_title: '接班人的考题' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async () => [{ series_id: '6050002', series_title: '接班', new_release: true, released_today: true, source: 'hongguo' }],
    });
    try {
      const result = await fixture.handlers['search-series']({}, '接班', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.meta.newRelease, 1, 'a longer old title must not hide the exact new short title');
      assert.ok(result.results.some(item => item.series_id === '6050002'));
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6051001', series_title: '接班人的考题特别篇' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async () => [{ series_id: '6051002', series_title: '接班人的考题', new_release: true, released_today: true, source: 'hongguo' }],
    });
    try {
      const result = await fixture.handlers['search-series']({}, '接班人的考题', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.meta.newRelease, 1, 'a longer old title must not suppress new-release lookup for 5+ character titles');
      assert.ok(result.results.some(item => item.series_id === '6051002'));
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6100001', series_title: '当天新剧' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async () => { throw new Error('must not run when the title already matches'); },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '当天新剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.meta.newRelease, 0);
      assert.equal(result.meta.newReleaseChecked, false);
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => { throw new Error('搜索服务暂不可用（HTTP 502）'); },
      newReleaseSearch: async () => [{ series_id: '6200001', series_title: '刚上线的新剧', new_release: true, source: 'hongguo' }],
    });
    try {
      const result = await fixture.handlers['search-series']({}, '刚上线的新剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.via, 'app-new');
      assert.equal(result.partial, true);
      assert.equal(result.meta.newRelease, 1);
      assert.match(result.error, /HTTP 502/);
    } finally { fixture.cleanup(); }
  }

  {
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [{ series_id: '6300001', series_title: '官网结果' }], total: 1, page: 1, totalPages: 1, hasMore: false }),
      newReleaseSearch: async () => { throw new Error('App 上新不可用'); },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '另一个剧名', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(result.results[0].series_id, '6300001');
      assert.equal(result.meta.newReleaseChecked, true);
      assert.match(result.meta.newReleaseError, /App 上新不可用/);
    } finally { fixture.cleanup(); }
  }

  {
    let calls = 0;
    const fixture = load({
      appEnabled: false,
      webSearch: async () => ({ results: [], total: 0, page: 1, totalPages: 0, hasMore: false }),
      newReleaseSearch: async () => { calls++; return []; },
    });
    try {
      const result = await fixture.handlers['search-series']({}, '剧', { source: 'hongguo' });
      assert.equal(result.success, true);
      assert.equal(calls, 0, 'single-character queries must not fetch App new releases');
      assert.equal(result.meta.newReleaseChecked, false);
    } finally { fixture.cleanup(); }
  }

  console.log('PASS app search IPC: opt-in App first, website fallback, pinned cursor pagination, new-release supplement');

  let failures = 0;
  async function check(name, run) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
  }

  await check('website page two returns success with the real native response shape', async () => {
    const requests = [];
    const { searchHongguo } = req('./src/native/hongguo-search');
    const fixture = load({ appEnabled: false, webSearch: (keyword, options) => searchHongguo(keyword, {
      ...options, cache: false, retries: 0,
      request: async (query, page) => {
        requests.push({ query, page });
        return { searchList: [{ video_data: { series_id: '5000002', series_title: '官网第二页' } }],
          totalCount: 3, pageNum: page, totalPages: 3, hasMore: true };
      },
    }) });
    try {
      const result = await fixture.handlers['search-series-more']({}, '测试剧', { source: 'hongguo', channel: 'web', page: 2 });
      assert.equal(result.success, true, 'native website result has no success field; IPC must supply it');
      assert.equal(result.channel, 'web');
      assert.equal(result.page, 2);
      assert.equal(result.results[0].series_id, '5000002');
      assert.equal(result.hasMore, true);
      assert.equal(result.meta.hasMore, true);
      assert.deepEqual(requests, [{ query: '测试剧', page: 2 }]);
    } finally { fixture.cleanup(); }
  });

  const providers = [
    { source: 'hongguo', channel: 'app', key: 'appSearch' },
    { source: 'hongguo', channel: 'web', key: 'webSearch' },
    { source: 'hema', key: 'hemaSearch' },
    { source: 'xifan', key: 'xifanSearch' },
    { source: 'custom:fixture', key: 'customSearch' },
  ];
  function providerFixture(provider, hasMore) {
    const calls = [];
    const fixture = load({ [provider.key]: async (keyword, pageOrOptions, requestOptions) => {
      const options = typeof pageOrOptions === 'object' ? pageOrOptions : { ...requestOptions, page: pageOrOptions };
      calls.push({ keyword, options });
      const page = options.page;
      return { ...(provider.channel === 'web' ? {} : { success: true }), channel: provider.channel,
        results: [{ series_id: `${provider.source}:${page}`, series_title: `测试剧第${page}页` }],
        page, total: 100, totalPages: 100, hasMore, nextPage: hasMore ? page + 1 : null,
        cursor: provider.channel === 'app' ? { next_offset: page * 20 } : undefined };
    } });
    return { ...fixture, calls };
  }

  for (const provider of providers.filter(item => !item.channel)) for (const hasMore of [true, false]) {
    await check(`${provider.source} forwards page two and hasMore=${hasMore}`, async () => {
      const fixture = providerFixture(provider, hasMore);
      try {
        const result = await fixture.handlers['search-series-more']({}, '测试剧', { source: provider.source, page: 2 });
        assert.equal(result.success, true);
        assert.equal(result.page, 2, 'page two must not repeat the first page');
        assert.equal(result.results[0].series_id, `${provider.source}:2`);
        assert.equal(result.hasMore, hasMore);
        assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.calls[0].options.page, 2);
        assert.ok(fixture.calls[0].options.deadline > Date.now());
      } finally { fixture.cleanup(); }
    });
  }

  for (const provider of providers) {
    const label = provider.channel || provider.source;
    await check(`${label} page fifty terminates pagination even if the provider advertises more`, async () => {
      const fixture = providerFixture(provider, true);
      try {
        const result = await fixture.handlers['search-series-more']({}, '测试剧', { source: provider.source, channel: provider.channel, page: 50 });
        assert.equal(result.hasMore, false);
        if (result.meta) assert.equal(result.meta.hasMore, false);
        assert.equal(result.success, true);
        assert.equal(result.page, 50);
        assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.calls[0].options.page, 50);
      } finally { fixture.cleanup(); }
    });
    await check(`${label} rejects invalid and out-of-range pages before calling the provider`, async () => {
      const fixture = providerFixture(provider, true);
      try {
        const notRejected = [];
        for (const page of [0, 1, -1, 2.5, 'invalid', NaN, Infinity, 51]) {
          const result = await fixture.handlers['search-series-more']({}, '测试剧', { source: provider.source, channel: provider.channel, page });
          if (result.success !== false || !result.error) notRejected.push(String(page));
        }
        assert.deepEqual(notRejected, [], 'every invalid page must be rejected with a visible error');
        assert.equal(fixture.calls.length, 0, 'invalid pages must never fetch or silently clamp to another page');
      } finally { fixture.cleanup(); }
    });
  }
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
