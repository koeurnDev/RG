const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ytdlp = require('./ytdlp');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let daemonState = null; // { child, port, secret, rpcUrl }
let startPromise = null;
let exitHookRegistered = false;
let reqCounter = 0;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function rawRpc(rpcUrl, secret, method, params = [], timeoutMs = 4000) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: String(++reqCounter),
      method,
      params: [`token:${secret}`, ...params],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`aria2 RPC HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data && data.error) {
    throw new Error(`aria2 RPC error (${data.error.code}): ${data.error.message}`);
  }
  return data.result;
}

function shutdownDaemon() {
  if (!daemonState) return;
  const st = daemonState;
  daemonState = null;
  ytdlp.killProcessTree(st.child);
}

/**
 * Lazily start and cache one persistent aria2c JSON-RPC daemon per Node process.
 */
async function ensureDaemon() {
  if (!ytdlp.isAria2Available()) {
    throw new Error('aria2c.exe មិនមាននៅក្នុង bin/');
  }
  if (daemonState && daemonState.child && daemonState.child.exitCode === null) {
    return daemonState;
  }
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const port = await getFreePort();
    const secret = crypto.randomBytes(12).toString('hex');
    const rpcUrl = `http://127.0.0.1:${port}/jsonrpc`;

    const args = [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${port}`,
      `--rpc-secret=${secret}`,
      '--max-concurrent-downloads=24',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--file-allocation=none',
      '--allow-overwrite=true',
      '--auto-file-renaming=false',
      '--continue=false',
      '--no-conf',
      '--check-certificate=false',
      '--connect-timeout=12',
      '--timeout=25',
      '--max-tries=2',
      '--retry-wait=1',
      '--quiet=true',
      `--stop-with-process=${process.pid}`,
    ];

    const child = spawn(ytdlp.ARIA2C_EXE, args, {
      windowsHide: true,
      stdio: 'ignore',
    });

    const state = { child, port, secret, rpcUrl };
    child.on('exit', () => {
      if (daemonState === state) daemonState = null;
    });
    child.on('error', () => {
      if (daemonState === state) daemonState = null;
    });

    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once('exit', shutdownDaemon);
    }

    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) break;
      try {
        await rawRpc(rpcUrl, secret, 'aria2.getVersion', [], 1000);
        ready = true;
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    if (!ready) {
      ytdlp.killProcessTree(child);
      throw new Error('aria2c RPC daemon failed to start');
    }

    daemonState = state;
    return state;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

function getDaemonStatus() {
  if (!daemonState || !daemonState.child || daemonState.child.exitCode !== null) {
    return { running: false, pid: null, port: null };
  }
  return { running: true, pid: daemonState.child.pid, port: daemonState.port };
}

/**
 * Download a direct MP4/media URL using the persistent aria2c RPC daemon (16 connections, zero spawn overhead).
 */
async function downloadViaRpc(variant, destPath, { signal, onBytesProgress, validateFileFn } = {}) {
  if (signal?.aborted) throw new Error('CANCELLED');
  const st = await ensureDaemon();
  if (signal?.aborted) throw new Error('CANCELLED');

  const destDir = path.dirname(destPath);
  const destName = path.basename(destPath);
  const controlPath = `${destPath}.aria2`;
  fs.mkdirSync(destDir, { recursive: true });

  const cleanupTemp = (removeDest = false) => {
    try { if (fs.existsSync(controlPath)) fs.unlinkSync(controlPath); } catch (_) {}
    if (removeDest) {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
    }
  };
  cleanupTemp(true);

  const uriOpts = {
    dir: destDir,
    out: destName,
    'user-agent': variant.userAgent || DEFAULT_UA,
    header: ['Accept: */*'],
    'max-connection-per-server': '16',
    split: '16',
    'min-split-size': '1M',
    'allow-overwrite': 'true',
    'auto-file-renaming': 'false',
    continue: 'false',
    'check-certificate': 'false',
    'connect-timeout': '12',
    timeout: '25',
    'max-tries': '2',
    'retry-wait': '1',
  };
  if (variant.referer) uriOpts.referer = variant.referer;

  const gid = await rawRpc(st.rpcUrl, st.secret, 'aria2.addUri', [[variant.url], uriOpts]);
  let removedByAbort = false;
  const onAbort = () => {
    removedByAbort = true;
    rawRpc(st.rpcUrl, st.secret, 'aria2.forceRemove', [gid], 1500).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let lastBytes = 0;
  let totalReported = 0;
  let completedOk = false;

  try {
    while (true) {
      if (signal?.aborted || removedByAbort) throw new Error('CANCELLED');
      const info = await rawRpc(st.rpcUrl, st.secret, 'aria2.tellStatus', [
        gid,
        ['status', 'totalLength', 'completedLength', 'errorCode', 'errorMessage'],
      ]);
      const curBytes = Number(info.completedLength) || 0;
      const totBytes = Number(info.totalLength) || 0;
      const pct = totBytes > 0 ? Math.min(99, Math.round((curBytes / totBytes) * 100)) : 25;
      const delta = Math.max(0, curBytes - lastBytes);
      if (curBytes > lastBytes) lastBytes = curBytes;
      if (delta > 0) {
        totalReported += delta;
        onBytesProgress?.(delta, pct, curBytes, totBytes);
      }

      if (info.status === 'complete') {
        const isValid = validateFileFn ? validateFileFn(destPath) : fs.existsSync(destPath);
        if (!isValid) {
          throw new Error('aria2c RPC output file invalid or too small');
        }
        const finalSize = fs.statSync(destPath).size;
        const remainder = Math.max(0, finalSize - totalReported);
        if (remainder > 0 || totalReported === 0) {
          onBytesProgress?.(remainder, 100, finalSize, finalSize);
        }
        completedOk = true;
        cleanupTemp(false);
        return finalSize;
      }
      if (info.status === 'removed' || signal?.aborted || removedByAbort) {
        throw new Error('CANCELLED');
      }
      if (info.status === 'error') {
        throw new Error(`aria2 RPC err ${info.errorCode || ''}: ${info.errorMessage || 'download failed'}`.trim());
      }

      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!completedOk) {
      rawRpc(st.rpcUrl, st.secret, 'aria2.forceRemove', [gid], 1000).catch(() => {});
      cleanupTemp(true);
    }
    rawRpc(st.rpcUrl, st.secret, 'aria2.removeDownloadResult', [gid], 1000).catch(() => {});
  }
}

module.exports = {
  ensureDaemon,
  shutdownDaemon,
  getDaemonStatus,
  downloadViaRpc,
};

