// Exercise the actual hidden-window queue with stalled Electron operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function scenario(stage) {
  const stuck = deferred(), windows = [];
  let timeOffset = 0;
  const makeWindow = () => {
    const index = windows.length, win = { destroyed: false, calls: [], isDestroyed: () => win.destroyed,
      destroy() { win.destroyed = true; },
      loadURL: () => {
        if (stage === 'late-load') timeOffset += 30;
        return stage === 'load' && index === 0 ? stuck.promise : Promise.resolve();
      },
      webContents: { executeJavaScript: script => {
        win.calls.push(script);
        if (stage === script && index === 0) return stuck.promise;
        if (stage === 'failure' && /加载失败|请刷新页面重试/.test(script)) return Promise.resolve(true);
        return Promise.resolve(script === 'cards' ? (['document.title', 'empty', 'failure'].includes(stage) && index === 0 ? '[]' : '[{"series_id":"1234567","series_title":"测试"}]') : script === 'document.title' ? '暂无结果' : '{}');
      } },
    };
    windows.push(win); return win;
  };
  let current;
  const context = vm.createContext({ console: { log() {}, warn() {} }, searchWindowReady: null, SEARCH_TIMEOUT_MS: 35,
    SEARCH_SITE: 'https://hongguoduanju.com', SEARCH_UA: '', SNIFFER_JS: 'cards', BROWSE_META_JS: 'meta',
    Date: { now: () => Date.now() + timeOffset },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 400 ? 1 : ms), clearTimeout,
    getSearchWindow: () => !current || current.destroyed ? (current = makeWindow()) : current,
  });
  vm.runInContext(source.slice(source.indexOf('async function runSniffOnUrl('), source.indexOf('async function runSearchSniff(')), context);
  const first = context.runSniffOnUrl('https://hongguoduanju.com/search/one', 'Search').catch(error => error);
  const next = context.runSniffOnUrl('https://hongguoduanju.com/search/two', 'Search');
  const outcome = await Promise.race([Promise.all([first, next]), delay(250).then(() => 'blocked')]);
  assert.notEqual(outcome, 'blocked', `${stage}: a stalled operation must release the search queue`);
  if (stage === 'late-load') {
    assert.equal(outcome[0].results.length, 1, 'a page loaded after the polling cutoff must still have its cards read');
    assert.equal(outcome[1].results.length, 1);
    assert.equal(windows[0].destroyed, false);
    return;
  }
  if (stage === 'empty') {
    assert.equal(outcome[0].success, true, 'normal empty search remains a successful empty result');
    assert.equal(outcome[0].results.length, 0);
    assert.equal(outcome[0].pageTitle, '暂无结果');
    return;
  }
  if (stage === 'failure') {
    assert.equal(outcome[0].success, false, 'a failed page must not be reported as a successful empty search');
    assert.match(outcome[0].error, /加载失败/);
    return;
  }
  assert.match(outcome[0].message, /超时/);
  assert.equal(outcome[1].success, true);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows.length, 2, 'next task needs a fresh window');
  const oldCalls = windows[0].calls.length;
  stuck.resolve(stage === 'cards' ? '[]' : '{}');
  await delay(8);
  assert.equal(windows[0].calls.length, oldCalls, 'late old operation must not start more work');
}
async function deadlineScenario() {
  const stuck = deferred();
  let current;
  const makeWindow = () => {
    const win = { destroyed: false, isDestroyed: () => win.destroyed, destroy() { win.destroyed = true; },
      loadURL: () => stuck.promise,
      webContents: { executeJavaScript: () => Promise.resolve('[]') } };
    current = win;
    return win;
  };
  const context = vm.createContext({ console: { log() {}, warn() {} }, searchWindowReady: null, SEARCH_TIMEOUT_MS: 5000,
    SEARCH_SITE: 'https://hongguoduanju.com', SEARCH_UA: '', SNIFFER_JS: 'cards', BROWSE_META_JS: 'meta',
    Date: { now: () => Date.now() }, setTimeout, clearTimeout, getSearchWindow: () => current || makeWindow(),
  });
  vm.runInContext(source.slice(source.indexOf('async function runSniffOnUrl('), source.indexOf('async function runSearchSniff(')), context);
  let firstSettled = false;
  const first = context.runSniffOnUrl('https://hongguoduanju.com/search/one', 'Search', { deadline: Date.now() + 1500 })
    .catch(error => { firstSettled = true; return error; });
  await delay(15);
  const queuedAt = Date.now();
  const second = context.runSniffOnUrl('https://hongguoduanju.com/search/two', 'Search', { deadline: Date.now() + 100 }).catch(error => error);
  const secondError = await second;
  const secondWait = Date.now() - queuedAt;
  assert.match(secondError.message, /超时/, 'a queued page search must respect its deadline');
  assert.ok(secondWait < 1200, 'a queued page search must return from its own deadline, not after the first task ends');
  assert.equal(firstSettled, false, 'the first task must still be running; otherwise this test cannot prove the queue deadline guard');
  const firstError = await first;
  assert.match(firstError.message, /超时/);
}

(async () => {
  for (const stage of ['late-load', 'empty', 'failure', 'load', 'cards', 'meta', 'document.title']) await scenario(stage);
  await deadlineScenario();
  console.log('PASS search timeout: late-loaded cards, empty results, loading/DOM/metadata/title deadlines, window recovery, queue continuation and late-work suppression');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
