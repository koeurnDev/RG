const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const file = path.resolve(__dirname, '../main.js'), req = createRequire(file);
const app = new EventEmitter(), updater = new EventEmitter();
Object.assign(app, { isPackaged: true, getVersion: () => '1.80.0', getPath: () => '/synthetic', commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
function networkSession() { return { calls: [], closed: 0, async setProxy(options) { this.calls.push(options); }, async closeAllConnections() { this.closed++; } }; }
const windowSession = networkSession(), updateSession = networkSession();
let settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'fixture', proxy_password: 'synthetic-password' }, downloads = 0, checks = 0;
Object.assign(updater, { netSession: updateSession, setFeedURL() {}, async checkForUpdates() {
  checks++;
  assert.equal(updateSession.calls.at(-1)?.proxyRules, 'http://127.0.0.1:7890', 'updater session must use proxy before network requests');
  return { updateInfo: { version: '2.0.0' }, cancellationToken: { cancel() {} } };
}, async downloadUpdate() { downloads++; updater.emit('update-downloaded', {version:'2.0.0'}); return ['/synthetic/update.zip']; } });
const handlers = {};
const electron = { app, session: { defaultSession: windowSession }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} } };
const context = vm.createContext({ require: name => name === 'electron' ? electron : name === 'electron-updater' ? {autoUpdater:updater} : name === './src/store' ? {setErrorHandler(){},getSettings:()=>settings} : req(name), __dirname:path.dirname(file),process: {...process, platform: 'darwin', env: {...process.env}}, Buffer,URL,AbortController,setTimeout,clearTimeout,setImmediate,console:{log(){},warn(){},error(){}} });
vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
require('./fixtures/trusted-ipc.cjs')(context,handlers);
const run = code => vm.runInContext(code,context);
(async()=>{
  run("latestAppRelease = {version:'2.0'}");
  const result = await handlers['download-app-update']({});
  assert.equal(result.success,true, 'in-app download must initialize the updater network session');
  assert.equal(downloads,1);
  assert.equal(updateSession.closed,1,'proxy changes must discard old connections');
  for (const host of ['127.0.0.1']) {
    let credentials;
    updater.emit('login',{isProxy:true,host,port:7890},(...args)=>{credentials=args;});
    assert.deepEqual(credentials,['fixture','synthetic-password']);
  }
  for(const challenge of [{isProxy:false,host:'127.0.0.1',port:7890},{isProxy:true,host:'evil.invalid',port:7890},{isProxy:true,host:'127.0.0.1',port:8888},{isProxy:true,host:'127.0.0.1',port:0}]) {
    let credentials;
    updater.emit('login',challenge,(...args)=>{credentials=args;});
    assert.deepEqual(credentials,[], 'unrelated challenge must be declined without credentials');
  }
  assert.equal(JSON.stringify(updateSession.calls).includes('synthetic-password'),false);
  await context.applyProxySettings({proxy_enabled:false});
  assert.equal(updateSession.calls.at(-1).mode,'direct');
  assert.equal(windowSession.calls.at(-1).mode,'direct');
  let credentials;updater.emit('login',{isProxy:true,host:'127.0.0.1',port:7890},(...args)=>{credentials=args;});
  assert.deepEqual(credentials,[]);
  await context.applyProxySettings({proxy_enabled:true,proxy_mode:'system'});
  assert.equal(updateSession.calls.at(-1).mode,'system');
  assert.equal(windowSession.calls.at(-1).mode,'system');
  assert.equal(updater.listenerCount('login'),1);
  const closures = updateSession.closed;
  await context.applyProxySettings({proxy_enabled:true,proxy_mode:'system'});
  assert.equal(updateSession.closed,closures,'unrelated settings must not interrupt ongoing connections');
  await handlers['cancel-app-update']({});
  let ready;
  updateSession.setProxy = () => new Promise(resolve=>{ready=resolve;});
  settings = {...settings,proxy_port:7891};
  run('sessionProxyConfigs.delete(appUpdater.netSession)');
  const preparing = handlers['download-app-update']({});
  await handlers['cancel-app-update']({});
  ready();
  assert.equal((await preparing).success,false,'cancel during proxy preparation must prevent starting a download');
  assert.equal(downloads,1);
  assert.equal(checks,1,'cancel during preparation must prevent updater network access');

  updateSession.setProxy = async config => { updateSession.calls.push(config); };
  let releaseWindow;
  windowSession.setProxy = async config => {
    if (config.proxyRules === 'http://127.0.0.1:7892') await new Promise(resolve => { releaseWindow = resolve; });
    windowSession.calls.push(config);
  };
  const changing = context.applyProxySettings({ ...settings, proxy_port: 7892 });
  for (let i = 0; i < 20 && !releaseWindow; i++) await Promise.resolve();
  assert.equal(typeof releaseWindow, 'function');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  updater.checkForUpdates = async () => {
    assert.equal(updateSession.calls.at(-1).proxyRules, 'http://127.0.0.1:7892', 'update traffic must follow the pending current choice, not stale persisted settings');
    return { updateInfo: { version: '2.0.0' }, cancellationToken: { cancel() {} } };
  };
  try {
    assert.equal((await handlers['download-app-update']({})).success, true, 'update session must retain the current proxy during save');
  } finally { releaseWindow(); await changing; }
  console.log('PASS update proxy: applied before download, connection reset, credential boundary, direct/system switching');
})().catch(error=>{console.error(error);process.exitCode=1});
