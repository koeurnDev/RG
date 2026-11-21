const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_SYNC_FILE = path.join(__dirname, '..', 'upstream-sync.json');
const DEFAULT_ENV_FILE = path.join(__dirname, '.env');
const CACHE_TTL_MS = 30 * 60 * 1000;

const DEFAULT_REPOS = {
  'jackotom/hongguo-drama': {
    label: 'HongGuo Drama (Core Native)',
    branch: 'main',
    commitPath: 'src/native',
    syncedSha: '92df757ed7be8ea658ee274a6a429b77f49e54e8',
    syncedRelease: '7.8',
    trackLatestRelease: true,
  },
  'N3urda/hongguoTV': {
    label: 'HongGuo TV (Protocol Reference)',
    branch: 'main',
    commitPath: 'kotlin-tv/core',
    syncedSha: '0646a063b060d2f0f5c41023c42a32227e7d8c22',
    syncedRelease: 'kotlin-v0.16.11',
    trackLatestRelease: true,
  },
  'ch6vip/novel-sound': {
    label: 'Novel Sound (V5 Reference)',
    branch: 'master',
    commitPath: 'rust/src',
    syncedSha: 'dde67f64f78d8e63a84a83b1aa059ff1c09e14e3',
    syncedRelease: '1.0.205',
    trackLatestRelease: true,
  },
};

let cachedReport = null;
let cachedAt = 0;

function readSyncState(syncFilePath = DEFAULT_SYNC_FILE) {
  try {
    if (fs.existsSync(syncFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(syncFilePath, 'utf8'));
      if (parsed && parsed.repos && typeof parsed.repos === 'object') {
        return {
          updatedAt: parsed.updatedAt || '',
          repos: parsed.repos,
        };
      }
    }
  } catch (_) {}
  return {
    updatedAt: '',
    repos: JSON.parse(JSON.stringify(DEFAULT_REPOS)),
  };
}

function writeSyncState(state, syncFilePath = DEFAULT_SYNC_FILE) {
  const payload = {
    updatedAt: state.updatedAt || new Date().toISOString(),
    repos: state.repos || {},
  };
  fs.writeFileSync(syncFilePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function defaultGithubRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        'User-Agent': 'EZA-PRO-Upstream-Watcher',
        Accept: 'application/vnd.github+json',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode || 0, headers: res.headers, raw, json });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout (${timeoutMs}ms)`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function shaMatches(syncedSha, latestSha) {
  const a = String(syncedSha || '').trim().toLowerCase();
  const b = String(latestSha || '').trim().toLowerCase();
  if (!a || !b) return false;
  return b.startsWith(a) || a.startsWith(b);
}

async function checkRepoUpstream(repo, cfg, { token = '', requestFn = defaultGithubRequest } = {}) {
  const authToken = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const commitPath = cfg.commitPath || '';
  const branch = cfg.branch || '';
  const queryParts = ['per_page=1'];
  if (commitPath) queryParts.push(`path=${encodeURIComponent(commitPath)}`);
  if (branch) queryParts.push(`sha=${encodeURIComponent(branch)}`);

  const commitUrl = `https://api.github.com/repos/${repo}/commits?${queryParts.join('&')}`;
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  const result = {
    repo,
    label: cfg.label || repo,
    commitPath,
    syncedSha: String(cfg.syncedSha || ''),
    syncedRelease: String(cfg.syncedRelease || ''),
    latestSha: '',
    latestShortSha: '',
    latestDate: '',
    latestMessage: '',
    latestCommitUrl: `https://github.com/${repo}`,
    latestReleaseTag: '',
    latestReleaseUrl: `https://github.com/${repo}/releases`,
    latestReleaseDate: '',
    hasNewCommit: false,
    hasNewRelease: false,
    hasUpdate: false,
    changedFiles: [],
    error: null,
  };

  try {
    const [commitRes, releaseRes] = await Promise.all([
      requestFn(commitUrl, { headers }),
      cfg.trackLatestRelease !== false
        ? requestFn(releaseUrl, { headers }).catch(() => ({ status: 404, json: null }))
        : Promise.resolve({ status: 404, json: null }),
    ]);

    if (commitRes.status >= 200 && commitRes.status < 300 && Array.isArray(commitRes.json) && commitRes.json[0]) {
      const latest = commitRes.json[0];
      result.latestSha = String(latest.sha || '');
      result.latestShortSha = result.latestSha.slice(0, 7);
      result.latestDate = String(latest.commit?.author?.date || latest.commit?.committer?.date || '');
      result.latestMessage = String(latest.commit?.message || '').split('\n')[0].trim();
      result.latestCommitUrl = String(latest.html_url || result.latestCommitUrl);
      if (result.latestSha) {
        result.hasNewCommit = !result.syncedSha || !shaMatches(result.syncedSha, result.latestSha);
      }
    } else if (commitRes.status !== 200) {
      result.error = commitRes.json?.message || `GitHub HTTP ${commitRes.status}`;
    }

    if (releaseRes.status >= 200 && releaseRes.status < 300 && releaseRes.json && releaseRes.json.tag_name) {
      result.latestReleaseTag = String(releaseRes.json.tag_name || '').trim();
      result.latestReleaseUrl = String(releaseRes.json.html_url || result.latestReleaseUrl);
      result.latestReleaseDate = String(releaseRes.json.published_at || '');
      const cleanSynced = result.syncedRelease.replace(/^v/i, '');
      const cleanLatest = result.latestReleaseTag.replace(/^v/i, '');
      if (cleanLatest && cleanLatest !== cleanSynced) {
        result.hasNewRelease = true;
      }
    }

    if (result.hasNewCommit && result.syncedSha && result.latestSha) {
      try {
        const cmpRes = await requestFn(
          `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(result.syncedSha)}...${encodeURIComponent(result.latestSha)}`,
          { headers }
        );
        if (cmpRes.status >= 200 && cmpRes.status < 300 && Array.isArray(cmpRes.json?.files)) {
          result.changedFiles = cmpRes.json.files
            .map((f) => f.filename)
            .filter((name) => !commitPath || name.startsWith(commitPath))
            .slice(0, 25);
        }
      } catch (_) {}
    }

    result.hasUpdate = Boolean(result.hasNewCommit || result.hasNewRelease);
  } catch (err) {
    result.error = err.message || 'Network error';
  }

  return result;
}

async function checkAllUpstreams({
  force = false,
  syncFilePath = DEFAULT_SYNC_FILE,
  token = '',
  requestFn = defaultGithubRequest,
} = {}) {
  const now = Date.now();
  const useDefaultCache = syncFilePath === DEFAULT_SYNC_FILE && requestFn === defaultGithubRequest;
  if (!force && useDefaultCache && cachedReport && (now - cachedAt) < CACHE_TTL_MS) {
    return { ...cachedReport, cached: true };
  }

  const state = readSyncState(syncFilePath);
  const entries = Object.entries(state.repos || {});
  const repos = await Promise.all(
    entries.map(([repo, cfg]) => checkRepoUpstream(repo, cfg, { token, requestFn }))
  );

  const hasUpdates = repos.some((r) => r.hasUpdate);
  const errorCount = repos.filter((r) => Boolean(r.error)).length;
  const updatedRepos = repos.filter((r) => r.hasUpdate);

  let summaryText = '✅ កូដទាញយក HongGuo គឺថ្មីបំផុតដូច GitHub ដើមហើយ!';
  if (hasUpdates) {
    summaryText = `🔔 មាន Update ថ្មីលើ GitHub (${updatedRepos.map((r) => r.repo).join(', ')})!`;
  } else if (errorCount === repos.length && repos.length > 0) {
    summaryText = `⚠️ មិនអាចឆែក GitHub បានទេ (${repos[0].error || 'Network error'})`;
  }

  const report = {
    checkedAt: new Date().toISOString(),
    syncedAt: state.updatedAt || '',
    cached: false,
    hasUpdates,
    errorCount,
    repos,
    summaryText,
  };

  if (useDefaultCache && errorCount < repos.length) {
    cachedReport = report;
    cachedAt = now;
  }

  return report;
}

async function syncUpstreamState({
  syncFilePath = DEFAULT_SYNC_FILE,
  token = '',
  requestFn = defaultGithubRequest,
} = {}) {
  const state = readSyncState(syncFilePath);
  const report = await checkAllUpstreams({ force: true, syncFilePath, token, requestFn });
  for (const r of report.repos) {
    const cfg = state.repos[r.repo];
    if (!cfg) continue;
    if (r.latestSha) cfg.syncedSha = r.latestSha;
    if (r.latestReleaseTag) cfg.syncedRelease = r.latestReleaseTag.replace(/^v/i, '');
  }
  state.updatedAt = new Date().toISOString();
  writeSyncState(state, syncFilePath);
  if (syncFilePath === DEFAULT_SYNC_FILE) {
    cachedReport = null;
    cachedAt = 0;
  }
  return { state, report };
}

function buildUpdateSignature(report) {
  return (report.repos || [])
    .filter((r) => r.hasUpdate)
    .map((r) => `${r.repo}@${r.latestShortSha || r.syncedSha}:${r.latestReleaseTag || r.syncedRelease}`)
    .sort()
    .join('|');
}

function formatTelegramMessage(report, targetRepo = 'koeurnDev/RG') {
  const lines = [
    `🔔 <b>EZA PRO: មាន Update ថ្មីពី GitHub Upstream!</b>`,
    ``,
  ];
  for (const r of report.repos || []) {
    if (!r.hasUpdate) continue;
    lines.push(`📦 <b>${r.repo}</b> (${r.label})`);
    if (r.hasNewRelease) {
      lines.push(`• Release ថ្មី: <code>${r.latestReleaseTag}</code> (មុន: ${r.syncedRelease || 'none'})`);
      lines.push(`• Link: ${r.latestReleaseUrl}`);
    }
    if (r.hasNewCommit) {
      lines.push(`• Commit ថ្មី (${r.commitPath}): <code>${r.latestShortSha}</code> — ${r.latestMessage}`);
      lines.push(`• Link: ${r.latestCommitUrl}`);
    }
    if (r.changedFiles.length > 0) {
      lines.push(`• Files: <code>${r.changedFiles.slice(0, 8).join(', ')}</code>`);
    }
    lines.push('');
  }
  lines.push(`👉 សូមពិនិត្យ និង Sync ចូល <b>${targetRepo}</b>`);
  return lines.join('\n');
}

function formatGithubIssueBody(report) {
  const sig = buildUpdateSignature(report);
  const lines = [
    `<!-- upstream-shas:${sig} -->`,
    `## 🔔 Upstream Update Detected`,
    ``,
    `Checked at: \`${report.checkedAt}\``,
    ``,
  ];
  for (const r of report.repos || []) {
    if (!r.hasUpdate) continue;
    lines.push(`### ${r.repo} — ${r.label}`);
    if (r.hasNewRelease) {
      lines.push(`- **New Release:** [\`${r.latestReleaseTag}\`](${r.latestReleaseUrl}) (synced: \`${r.syncedRelease || 'none'}\`)`);
    }
    if (r.hasNewCommit) {
      lines.push(`- **New Commit in \`${r.commitPath}\`:** [\`${r.latestShortSha}\`](${r.latestCommitUrl}) — ${r.latestMessage} (${r.latestDate})`);
    }
    if (r.changedFiles.length > 0) {
      lines.push(`- **Changed files:**`);
      for (const f of r.changedFiles) {
        lines.push(`  - \`${f}\``);
      }
    }
    lines.push('');
  }
  lines.push(`---`);
  lines.push(`After syncing the changes locally, run \`npm run check:upstream -- --sync\` and commit \`upstream-sync.json\`, then close this issue.`);
  return lines.join('\n');
}

async function sendTelegramAlert({ botToken, chatId, message, requestFn = defaultGithubRequest }) {
  if (!botToken || !chatId || !message) return { sent: false, reason: 'missing_credentials' };
  const body = JSON.stringify({
    chat_id: String(chatId),
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  const res = await requestFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  if (res.status < 200 || res.status >= 300 || !res.json?.ok) {
    throw new Error(`Telegram API failed (${res.status}): ${res.json?.description || res.raw || 'unknown'}`);
  }
  return { sent: true, messageId: res.json.result?.message_id };
}

function loadTelegramConfigFromEnvFile(envFilePath = DEFAULT_ENV_FILE) {
  let botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  let chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (botToken && chatId) return { botToken, chatId };

  try {
    if (!fs.existsSync(envFilePath)) return { botToken, chatId };
    const lines = fs.readFileSync(envFilePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    for (const line of lines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (/^TELEGRAM_BOT_TOKEN$/i.test(k) && !botToken) botToken = v;
        if (/^TELEGRAM_CHAT_ID$/i.test(k) && !chatId) chatId = v;
      } else if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(line) && !botToken) {
        botToken = line;
      } else if (/^-?\d{5,}$/.test(line) && !chatId) {
        chatId = line;
      }
    }
  } catch (_) {}

  return { botToken, chatId };
}

module.exports = {
  DEFAULT_SYNC_FILE,
  DEFAULT_ENV_FILE,
  readSyncState,
  writeSyncState,
  checkRepoUpstream,
  checkAllUpstreams,
  syncUpstreamState,
  buildUpdateSignature,
  formatTelegramMessage,
  formatGithubIssueBody,
  sendTelegramAlert,
  loadTelegramConfigFromEnvFile,
  clearCache: () => { cachedReport = null; cachedAt = 0; },
};
