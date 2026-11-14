/**
 * EZA PRO Downloader - Cloud License Client & ECDSA P-256 Lease Verifier
 * Keeps signing secrets on Cloudflare Worker; desktop holds only Worker URL + Public Key JWK.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'cloud-license-config.json');
const DEFAULT_GRACE_HOURS = 12;

let cachedConfig = null;
let cachedMtime = 0;

function normalizeMachineId(hwid) {
  return String(hwid || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function getMachineHardwareId() {
  try {
    const cpus = os.cpus() || [];
    const cpuModel = cpus[0] ? cpus[0].model : 'generic-cpu';
    const raw = `${os.platform()}|${os.arch()}|${os.hostname()}|${cpuModel}|${cpus.length}`;
    const digest = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    return `EZA-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
  } catch (_) {
    return 'EZA-0000-0000-0000';
  }
}

function normalizeLicenseKey(key) {
  return String(key || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function loadCloudLicenseConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const stat = fs.statSync(CONFIG_PATH);
      if (!cachedConfig || stat.mtimeMs !== cachedMtime) {
        cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        cachedMtime = stat.mtimeMs;
      }
      fileCfg = cachedConfig || {};
    }
  } catch (_) {}

  let envPubJwk = null;
  if (process.env.EZA_CLOUD_PUBLIC_JWK) {
    try {
      envPubJwk = JSON.parse(process.env.EZA_CLOUD_PUBLIC_JWK);
    } catch (_) {}
  }

  return {
    workerUrl: String(process.env.EZA_CLOUD_LICENSE_URL || fileCfg.workerUrl || '').trim().replace(/\/+$/, ''),
    publicKeyJwk: envPubJwk || fileCfg.publicKeyJwk || null,
    appId: String(fileCfg.appId || 'downloader').trim().toLowerCase(),
    enforceInPackaged: fileCfg.enforceInPackaged !== false,
    offlineGraceHours: Number(fileCfg.offlineGraceHours || DEFAULT_GRACE_HOURS)
  };
}

function isCloudLicenseEnforced() {
  if (process.env.EZA_REQUIRE_CLOUD_LICENSE === '0') return false;
  const cfg = loadCloudLicenseConfig();
  if (!cfg.workerUrl || !cfg.publicKeyJwk) return false;
  if (process.env.EZA_REQUIRE_CLOUD_LICENSE === '1') return true;
  return process.env.EZA_PACKAGED_CLIENT === '1' && cfg.enforceInPackaged;
}

function getCloudLicenseStatePath() {
  if (process.env.EZA_CLOUD_LICENSE_STATE_FILE) {
    return process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  }
  const baseDir =
    process.env.EZA_USER_DATA_DIR ||
    (process.env.HDRG_CONFIG_FILE ? path.dirname(process.env.HDRG_CONFIG_FILE) : path.join(__dirname, '..'));
  return path.join(baseDir, 'cloud-license-state.json');
}

function getVaultKey() {
  let user = 'default';
  try {
    user = os.userInfo().username || 'default';
  } catch (_) {}
  const secret = `${os.hostname()}:${user}:eza-pro-downloader-lease-v1`;
  return crypto.scryptSync(secret, 'eza-pro-downloader-salt-v1', 32);
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptText(payload) {
  if (typeof payload !== 'string' || !payload.includes(':')) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function loadStoredCloudLicenseState() {
  const filePath = getCloudLicenseStatePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!wrapper || typeof wrapper.sealed !== 'string') return null;
    const rawJson = decryptText(wrapper.sealed);
    return rawJson ? JSON.parse(rawJson) : null;
  } catch (_) {
    return null;
  }
}

function saveStoredCloudLicenseState(stateObj) {
  const filePath = getCloudLicenseStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sealed = encryptText(JSON.stringify(stateObj || {}));
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, sealed }, null, 2), 'utf8');
}

function clearStoredCloudLicenseState({ preserveKey = false } = {}) {
  const filePath = getCloudLicenseStatePath();
  if (!preserveKey) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    return;
  }
  const existing = loadStoredCloudLicenseState();
  if (!existing || !existing.licenseKey) return;
  saveStoredCloudLicenseState({
    licenseKey: existing.licenseKey,
    leaseToken: '',
    remoteSettings: existing.remoteSettings || {},
    checkedAt: Date.now()
  });
}

function verifySignedLeaseToken(leaseToken, machineId, publicKeyJwk, nowMs = Date.now(), expectedAppId = '') {
  if (typeof leaseToken !== 'string' || !leaseToken.includes('.') || !publicKeyJwk) {
    return { valid: false, reason: 'invalid_token' };
  }
  const [payloadB64, sigB64] = leaseToken.split('.');
  if (!payloadB64 || !sigB64) {
    return { valid: false, reason: 'invalid_token' };
  }

  let payload;
  try {
    const pubKey = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
    const sigOk = crypto.verify(
      'sha256',
      Buffer.from(payloadB64, 'utf8'),
      { key: pubKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64, 'base64url')
    );
    if (!sigOk) {
      return { valid: false, reason: 'invalid_signature' };
    }
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const normalizedHwid = normalizeMachineId(machineId);
  if (!payload || normalizeMachineId(payload.machineId) !== normalizedHwid) {
    return { valid: false, reason: 'machine_mismatch' };
  }
  if (expectedAppId && payload.appScope && payload.appScope !== 'all' && payload.appScope !== expectedAppId) {
    return { valid: false, reason: 'wrong_app', payload };
  }
  if (payload.status !== 'active') {
    return { valid: false, reason: payload.status || 'revoked' };
  }
  if (payload.expiresAt !== null && payload.expiresAt !== undefined && Number(payload.expiresAt) > 0 && nowMs > Number(payload.expiresAt)) {
    return { valid: false, reason: 'expired', payload };
  }
  if (!payload.leaseUntil || nowMs > Number(payload.leaseUntil)) {
    return { valid: false, reason: 'lease_expired', payload };
  }
  return { valid: true, payload };
}

function hasActiveLocalLease(machineId = getMachineHardwareId(), nowMs = Date.now()) {
  const cfg = loadCloudLicenseConfig();
  const stored = loadStoredCloudLicenseState();
  if (!stored || !stored.leaseToken) return false;
  const check = verifySignedLeaseToken(stored.leaseToken, machineId, cfg.publicKeyJwk, nowMs, cfg.appId);
  return Boolean(check.valid);
}

function maskLicenseKey(key) {
  const clean = normalizeLicenseKey(key);
  if (!clean) return '';
  const parts = clean.split('-');
  if (parts.length < 3) return `${clean.slice(0, 4)}****`;
  return `${parts[0]}-${parts[1]}-****-${parts[parts.length - 1]}`;
}

function getCloudLicenseSummary(machineId = getMachineHardwareId(), nowMs = Date.now()) {
  const cfg = loadCloudLicenseConfig();
  const stored = loadStoredCloudLicenseState();
  const remoteSettings = (stored && stored.remoteSettings) || {};
  if (!stored || !stored.leaseToken) {
    return {
      licensed: false,
      maskedKey: stored && stored.licenseKey ? maskLicenseKey(stored.licenseKey) : '',
      customerName: '',
      appScope: 'all',
      expiresAt: null,
      remoteSettings
    };
  }
  const check = verifySignedLeaseToken(stored.leaseToken, machineId, cfg.publicKeyJwk, nowMs, cfg.appId);
  const payload = check.payload || {};
  return {
    licensed: Boolean(check.valid),
    maskedKey: maskLicenseKey(stored.licenseKey || payload.licenseKey || ''),
    customerName: String(payload.customerName || ''),
    appScope: String(payload.appScope || 'all'),
    expiresAt: payload.expiresAt || null,
    leaseUntil: payload.leaseUntil || null,
    remoteSettings
  };
}

async function verifyCloudLicenseKey({ licenseKey = '', machineId = getMachineHardwareId(), appVersion = '1.0.0', fetchImpl = null } = {}) {
  const cfg = loadCloudLicenseConfig();
  if (!cfg.workerUrl || !cfg.publicKeyJwk) {
    return {
      valid: false,
      source: 'config',
      reason: 'not_configured',
      error: 'Cloud License Server មិនទាន់ត្រូវបានកំណត់រចនាសម្ព័ន្ធទេ។'
    };
  }

  const stored = loadStoredCloudLicenseState();
  const keyToUse = normalizeLicenseKey(licenseKey || (stored && stored.licenseKey) || '');
  const cleanHwid = normalizeMachineId(machineId);

  if (!keyToUse) {
    return {
      valid: false,
      source: 'local',
      reason: 'missing_key',
      error: 'សូមបញ្ចូល License Key ដើម្បីចូលប្រើប្រាស់កម្មវិធី។'
    };
  }

  const doFetch = fetchImpl || global.fetch;
  if (typeof doFetch !== 'function') {
    return {
      valid: false,
      source: 'config',
      reason: 'no_fetch',
      error: 'HTTP client មិនដំណើរការ។'
    };
  }

  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8500) : null;
    let res;
    try {
      res = await doFetch(`${cfg.workerUrl}/api/license/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          licenseKey: keyToUse,
          machineId: cleanHwid,
          appId: cfg.appId,
          appVersion
        }),
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const data = await res.json().catch(() => null);
    if (res.status >= 500 || !data || typeof data !== 'object') {
      throw new Error(`Cloud server temporary error (${res.status})`);
    }

    if (!res.ok || !data.valid) {
      const reason = data.reason || 'rejected';
      const keepKeyOnly = reason === 'maintenance';
      if (keepKeyOnly) {
        saveStoredCloudLicenseState({
          licenseKey: keyToUse,
          leaseToken: '',
          remoteSettings: {
            maintenanceBanner: data.maintenanceBanner || '',
            downloadUrl: data.downloadUrl || ''
          },
          checkedAt: Date.now()
        });
      } else {
        clearStoredCloudLicenseState({ preserveKey: false });
      }
      return {
        valid: false,
        source: 'cloud',
        reason,
        error: data.error || 'License Key មិនមានសិទ្ធិប្រើប្រាស់ទេ។',
        maintenanceBanner: data.maintenanceBanner || '',
        maintenanceLocked: Boolean(data.maintenanceLocked),
        downloadUrl: data.downloadUrl || ''
      };
    }

    const sigCheck = verifySignedLeaseToken(data.leaseToken, cleanHwid, cfg.publicKeyJwk, Date.now(), cfg.appId);
    if (!sigCheck.valid) {
      clearStoredCloudLicenseState({ preserveKey: false });
      return {
        valid: false,
        source: 'cloud',
        reason: sigCheck.reason || 'invalid_signature',
        error: sigCheck.reason === 'wrong_app'
          ? 'License Key នេះមិនអនុញ្ញាតឲ្យប្រើជាមួយ EZA PRO Downloader បានទេ។'
          : 'ការផ្ទៀងផ្ទាត់សុវត្ថិភាព License មិនត្រឹមត្រូវទេ។'
      };
    }

    const remoteSettings = {
      maintenanceBanner: String(data.maintenanceBanner || ''),
      minAppVersion: String(data.minAppVersion || ''),
      downloadUrl: String(data.downloadUrl || '')
    };

    saveStoredCloudLicenseState({
      licenseKey: keyToUse,
      leaseToken: data.leaseToken,
      remoteSettings,
      checkedAt: Date.now()
    });

    return {
      valid: true,
      source: 'cloud',
      appScope: data.appScope || sigCheck.payload.appScope || 'all',
      customerName: data.customerName || sigCheck.payload.customerName || '',
      maskedKey: maskLicenseKey(keyToUse),
      expiresAt: data.expiresAt || null,
      maxMachines: data.maxMachines || 1,
      boundCount: data.boundCount || 1,
      leaseUntil: sigCheck.payload.leaseUntil,
      maintenanceBanner: remoteSettings.maintenanceBanner,
      minAppVersion: remoteSettings.minAppVersion,
      downloadUrl: remoteSettings.downloadUrl
    };
  } catch (networkErr) {
    if (stored && stored.leaseToken && normalizeLicenseKey(stored.licenseKey) === keyToUse) {
      const graceCheck = verifySignedLeaseToken(stored.leaseToken, cleanHwid, cfg.publicKeyJwk, Date.now(), cfg.appId);
      if (graceCheck.valid) {
        const remoteSettings = stored.remoteSettings || {};
        return {
          valid: true,
          source: 'offline_grace',
          appScope: graceCheck.payload.appScope || 'all',
          customerName: graceCheck.payload.customerName || '',
          maskedKey: maskLicenseKey(keyToUse),
          expiresAt: graceCheck.payload.expiresAt || null,
          leaseUntil: graceCheck.payload.leaseUntil,
          maintenanceBanner: remoteSettings.maintenanceBanner || '',
          downloadUrl: remoteSettings.downloadUrl || ''
        };
      }
    }
    return {
      valid: false,
      source: 'offline',
      reason: 'network_required',
      error: 'មិនអាចភ្ជាប់ Cloud Server បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្ដងទៀត។',
      detail: networkErr && networkErr.message ? networkErr.message : ''
    };
  }
}

module.exports = {
  normalizeMachineId,
  getMachineHardwareId,
  normalizeLicenseKey,
  loadCloudLicenseConfig,
  isCloudLicenseEnforced,
  getCloudLicenseStatePath,
  loadStoredCloudLicenseState,
  saveStoredCloudLicenseState,
  clearStoredCloudLicenseState,
  verifySignedLeaseToken,
  hasActiveLocalLease,
  getCloudLicenseSummary,
  verifyCloudLicenseKey,
  maskLicenseKey
};

