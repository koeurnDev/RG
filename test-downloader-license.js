const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function signTestLease(payload, privateKey) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${payloadB64}.${sig.toString('base64url')}`;
}

test('EZA PRO Downloader: Cloud License ECDSA signature, appScope guard & anti-bypass server gate', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-dl-lic-'));
  const origEnv = { ...process.env };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });

  process.env.EZA_PACKAGED_CLIENT = '1';
  process.env.EZA_REQUIRE_CLOUD_LICENSE = '1';
  process.env.HDRG_ISOLATED = '1';
  process.env.EZA_USER_DATA_DIR = tmpDir;
  process.env.HDRG_CONFIG_FILE = path.join(tmpDir, 'config.json');
  process.env.EZA_CLOUD_LICENSE_STATE_FILE = path.join(tmpDir, 'cloud-license-state.json');
  process.env.EZA_DEFAULT_DOWNLOAD_DIR = path.join(tmpDir, 'Downloads');
  process.env.EZA_CLOUD_PUBLIC_JWK = JSON.stringify(pubJwk);
  process.env.EZA_CLOUD_LICENSE_URL = 'https://eza-pro-license-admin.koeurnseab630.workers.dev';

  let started = null;
  try {
    const cloudLicense = require('./lib/cloud-license');
    const ytdlp = require('./lib/ytdlp');
    const uiServer = require('./ui_server');

    const machineId = cloudLicense.getMachineHardwareId();
    assert.match(machineId, /^EZA-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    assert.equal(cloudLicense.isCloudLicenseEnforced(), true);
    assert.ok(fs.existsSync(path.join(ytdlp.BIN_DIR, 'ffmpeg.exe')), 'Expected ffmpeg.exe in resolved BIN_DIR');

    const now = Date.now();
    const validDlLease = signTestLease({
      v: 1,
      licenseKey: 'EZAPRO-1111-2222-3333-4444',
      machineId,
      appScope: 'downloader',
      status: 'active',
      customerName: 'Downloader VIP',
      expiresAt: now + 86400000,
      issuedAt: now,
      leaseUntil: now + 3600000
    }, privateKey);

    const studioOnlyLease = signTestLease({
      v: 1,
      licenseKey: 'EZAPRO-9999-8888-7777-6666',
      machineId,
      appScope: 'studio',
      status: 'active',
      customerName: 'Studio Only User',
      expiresAt: now + 86400000,
      issuedAt: now,
      leaseUntil: now + 3600000
    }, privateKey);

    // Signed token checks: matching HWID + downloader scope passes; wrong HWID / tampered / studio-only fails
    assert.equal(cloudLicense.verifySignedLeaseToken(validDlLease, machineId, pubJwk, now, 'downloader').valid, true);
    assert.equal(cloudLicense.verifySignedLeaseToken(validDlLease, 'EZA-0000-0000-0000', pubJwk, now, 'downloader').valid, false);
    assert.equal(cloudLicense.verifySignedLeaseToken(studioOnlyLease, machineId, pubJwk, now, 'downloader').reason, 'wrong_app');

    // Start local backend HTTP server without warmup external network calls
    started = await uiServer.startServer({ port: 0, host: '127.0.0.1', warmUp: false });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    // Verify public status endpoint works and reports unlicensed
    const stRes = await fetch(`${baseUrl}/api/license/status`);
    assert.equal(stRes.status, 200);
    const stJson = await stRes.json();
    assert.equal(stJson.cloudLicenseEnforced, true);
    assert.equal(stJson.licensed, false);
    assert.equal(stJson.machineId, machineId);

    // Protected downloader endpoints MUST reject with 403 while locked
    for (const ep of [
      { url: '/api/config', method: 'GET' },
      { url: '/api/library', method: 'GET' },
      { url: '/api/start-download', method: 'POST', body: '{}' },
      { url: '/api/resolve', method: 'POST', body: '{}' },
      { url: '/download/tool', method: 'GET' }
    ]) {
      const blocked = await fetch(`${baseUrl}${ep.url}`, {
        method: ep.method,
        headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
        body: ep.body
      });
      const expectedCode = ep.url === '/download/tool' ? 403 : 403;
      assert.equal(blocked.status, expectedCode, `Expected 403 on ${ep.url} while locked`);
    }

    // Activate valid downloader lease via client helper
    const verifyOk = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: 'EZAPRO-1111-2222-3333-4444',
      machineId,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          valid: true,
          appScope: 'downloader',
          leaseToken: validDlLease,
          customerName: 'Downloader VIP',
          expiresAt: now + 86400000
        })
      })
    });
    assert.equal(verifyOk.valid, true);
    assert.equal(cloudLicense.hasActiveLocalLease(machineId), true);

    // Protected APIs work once licensed, and packaged /download/tool stays 404
    const cfgAfter = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgAfter.status, 200);
    const dlDirAfter = await fetch(`${baseUrl}/api/download-dir`);
    const dlDirJson = await dlDirAfter.json();
    assert.equal(dlDirAfter.status, 200);
    assert.equal(dlDirJson.path, process.env.EZA_DEFAULT_DOWNLOAD_DIR);
    const toolRes = await fetch(`${baseUrl}/download/tool`);
    assert.equal(toolRes.status, 404);

    // Offline grace passes when Worker temporarily unreachable
    const offlineOk = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    assert.equal(offlineOk.valid, true);
    assert.equal(offlineOk.source, 'offline_grace');

    // Revocation clears lease immediately and re-locks APIs
    const revoked = await cloudLicense.verifyCloudLicenseKey({
      licenseKey: '',
      machineId,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ success: false, valid: false, reason: 'revoked', error: 'Revoked' })
      })
    });
    assert.equal(revoked.valid, false);
    const lockedAgain = await fetch(`${baseUrl}/api/library`);
    assert.equal(lockedAgain.status, 403);
  } finally {
    try {
      if (started) require('./ui_server').stopServer();
    } catch (_) {}
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

