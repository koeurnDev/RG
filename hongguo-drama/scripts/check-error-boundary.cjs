// Real React/Electron rendering in an isolated profile; no network or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-boundary-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename, profile], { env, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(result.stdout || '');
    if (result.status !== 0) process.stderr.write(result.stderr || result.error?.message || 'Electron check failed');
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = require('electron');
  const { once } = require('node:events');
  const profile = process.argv[2];
  app.setPath('userData', profile);
  app.whenReady().then(async () => {
    const { outputFiles } = await require('esbuild').build({
      entryPoints: [path.resolve(__dirname, '../src/main.jsx')], bundle: true,
      write: false, outdir: profile, define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'crashing-app-fixture', setup(build) {
        build.onLoad({ filter: /[/\\]src[/\\]App\.jsx$/ }, () => ({
          contents: `import React, { useState } from 'react';
            function Child({ crash }) { if (crash) throw Error('PRIVATE_STACK_SENTINEL'); return <p>正常界面</p>; }
            export default function App() { const [crash, setCrash] = useState(false);
              window.crashFixture = () => setCrash(true); return <Child crash={crash} />; }`,
          loader: 'jsx', resolveDir: path.resolve(__dirname, '../src'),
        }));
      } }],
    });
    for (const file of outputFiles) fs.writeFileSync(file.path, file.contents);
    const html = path.join(profile, 'index.html');
    fs.writeFileSync(html, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script src="main.js"></script></body></html>');
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } });
    const read = code => win.webContents.executeJavaScript(code);
    const settle = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await win.loadFile(html);
    await settle();
    assert.equal(await read('document.body.innerText'), '正常界面', 'normal children must render');
    await read('window.crashFixture()');
    await settle();
    const fallback = await read(`({ text: document.body.innerText,
      alert: !!document.querySelector('[role="alert"]'),
      button: document.querySelector('button')?.innerText })`);
    assert.match(fallback.text, /界面.*异常/, 'render crash must show a Chinese recovery message');
    assert(fallback.alert, 'recovery message must be announced to assistive technology');
    assert.equal(fallback.button, '重新加载');
    assert(!fallback.text.includes('PRIVATE_STACK_SENTINEL'), 'error details must stay out of the UI');
    const reloaded = once(win.webContents, 'did-finish-load');
    await read('document.querySelector("button").click()');
    await reloaded;
    await settle();
    assert.equal(await read('document.body.innerText'), '正常界面', 'reload must restore the application');
    console.log('PASS error boundary: normal render → real child crash → accessible private-safe fallback → reload recovery');
    win.destroy();
    app.exit(0);
  }).catch(error => { console.error('FAIL error boundary: ' + error.message); app.exit(1); });
}
