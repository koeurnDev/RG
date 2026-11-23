#!/usr/bin/env node
const https = require('https');
const radar = require('../lib/tech-radar');

const args = new Set(process.argv.slice(2));
const STATE_ISSUE_TITLE = '[Tech Radar State]';

function ghApi(urlPath, { method = 'GET', token, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(`https://api.github.com${urlPath}`, {
      method,
      headers: {
        'User-Agent': 'EZA-PRO-Tech-Radar/1.0',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode || 0, json, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseIssueState(body = '') {
  const m = String(body || '').match(/<!--\s*tech-radar-state:([\s\S]*?)-->/);
  if (!m) return { lastDate: '', seenKeys: [] };
  try {
    const obj = JSON.parse(m[1]);
    return {
      lastDate: String(obj.lastDate || ''),
      seenKeys: Array.isArray(obj.seenKeys) ? obj.seenKeys.slice(0, 120) : [],
    };
  } catch (_) {
    return { lastDate: '', seenKeys: [] };
  }
}

async function loadStateFromIssue(ghRepo, ghToken) {
  if (!ghRepo || !ghToken) return { issueNumber: null, state: { lastDate: '', seenKeys: [] } };
  const res = await ghApi(`/repos/${ghRepo}/issues?state=all&per_page=30`, { token: ghToken });
  if (res.status !== 200 || !Array.isArray(res.json)) {
    return { issueNumber: null, state: { lastDate: '', seenKeys: [] } };
  }
  const found = res.json.find((iss) => String(iss.title || '').trim() === STATE_ISSUE_TITLE);
  if (!found) return { issueNumber: null, state: { lastDate: '', seenKeys: [] } };
  return { issueNumber: found.number, state: parseIssueState(found.body || '') };
}

async function saveStateToIssue(ghRepo, ghToken, issueNumber, nextState) {
  if (!ghRepo || !ghToken) return;
  const compactState = {
    lastDate: nextState.lastDate,
    seenKeys: [...new Set(nextState.seenKeys || [])].slice(-120),
  };
  const body = [
    `<!-- tech-radar-state:${JSON.stringify(compactState)} -->`,
    `Automated daily tracker metadata for EZA PRO Daily Open-Source Tech Radar.`,
    `- Last sent date: \`${compactState.lastDate}\``,
    `- Tracked keys: \`${compactState.seenKeys.length}\``,
  ].join('\n');

  if (issueNumber) {
    await ghApi(`/repos/${ghRepo}/issues/${issueNumber}`, {
      method: 'PATCH',
      token: ghToken,
      body: { title: STATE_ISSUE_TITLE, body, state: 'closed' },
    });
  } else {
    const created = await ghApi(`/repos/${ghRepo}/issues`, {
      method: 'POST',
      token: ghToken,
      body: { title: STATE_ISSUE_TITLE, body },
    });
    if (created.json?.number) {
      await ghApi(`/repos/${ghRepo}/issues/${created.json.number}`, {
        method: 'PATCH',
        token: ghToken,
        body: { state: 'closed' },
      });
    }
  }
}

(async () => {
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const ghRepo = process.env.GITHUB_REPOSITORY || '';
  const forceSend = args.has('--force');

  const { issueNumber, state } = await loadStateFromIssue(ghRepo, ghToken);
  const todayStr = new Date().toISOString().slice(0, 10);
  if (!forceSend && !args.has('--dry-run') && state.lastDate === todayStr) {
    console.log(`[Tech Radar] Already sent digest for ${todayStr}. Use --force to resend.`);
    return;
  }

  const seenSet = new Set(state.seenKeys || []);
  const digest = await radar.buildDailyTechDigest({ token: ghToken, seenKeys: seenSet });
  const messages = radar.formatTelegramDigestMessages(digest);

  if (args.has('--json')) {
    console.log(JSON.stringify({ digest, messages }, null, 2));
    return;
  }

  if (args.has('--dry-run') || (!args.has('--notify') && !args.has('--send'))) {
    console.log(messages.join('\n\n--- SPLIT ---\n\n'));
    return;
  }

  const tgCfg = radar.loadTelegramConfigFromEnvFile();
  if (!tgCfg.botToken || !tgCfg.chatId) {
    console.log('[Tech Radar] Telegram alert skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured).');
    return;
  }

  for (const msg of messages) {
    const res = await radar.sendTelegramAlert({
      botToken: tgCfg.botToken,
      chatId: tgCfg.chatId,
      message: msg,
    });
    console.log(`[Tech Radar] Sent Telegram digest part (messageId=${res.messageId})`);
  }

  await saveStateToIssue(ghRepo, ghToken, issueNumber, {
    lastDate: todayStr,
    seenKeys: [...(state.seenKeys || []), ...(digest.collectedKeys || [])],
  });
})().catch((err) => {
  console.error('[Tech Radar Error]', err.message);
  process.exit(1);
});
