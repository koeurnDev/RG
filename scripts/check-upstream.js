#!/usr/bin/env node
const https = require('https');
const watcher = require('../lib/upstream-watcher');

const args = new Set(process.argv.slice(2));

function ghApi(urlPath, { method = 'GET', token, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(`https://api.github.com${urlPath}`, {
      method,
      headers: {
        'User-Agent': 'EZA-PRO-Upstream-Watcher',
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
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function notifyIfNew(report) {
  const signature = watcher.buildUpdateSignature(report);
  if (!signature) return { notified: false, reason: 'no_updates' };

  const ghToken = process.env.GITHUB_TOKEN || '';
  const ghRepo = process.env.GITHUB_REPOSITORY || '';
  const tgCfg = watcher.loadTelegramConfigFromEnvFile();
  const tgToken = tgCfg.botToken;
  const tgChatId = tgCfg.chatId;

  let alreadyNotified = false;
  let existingIssueNumber = null;

  if (ghToken && ghRepo) {
    const issuesRes = await ghApi(`/repos/${ghRepo}/issues?state=open&per_page=30`, { token: ghToken });
    if (issuesRes.status === 200 && Array.isArray(issuesRes.json)) {
      const existing = issuesRes.json.find((iss) => String(iss.title || '').startsWith('[Upstream Update]'));
      if (existing) {
        existingIssueNumber = existing.number;
        const body = String(existing.body || '');
        if (body.includes(`<!-- upstream-shas:${signature} -->`)) {
          alreadyNotified = true;
        }
      }
    }
  }

  if (alreadyNotified) {
    console.log(`Already notified for signature: ${signature}`);
    return { notified: false, reason: 'already_notified', signature };
  }

  if (ghToken && ghRepo) {
    const updatedNames = report.repos.filter((r) => r.hasUpdate).map((r) => r.repo).join(', ');
    const title = `[Upstream Update] ${updatedNames}`;
    const body = watcher.formatGithubIssueBody(report);
    if (existingIssueNumber) {
      await ghApi(`/repos/${ghRepo}/issues/${existingIssueNumber}`, {
        method: 'PATCH',
        token: ghToken,
        body: { title, body },
      });
      await ghApi(`/repos/${ghRepo}/issues/${existingIssueNumber}/comments`, {
        method: 'POST',
        token: ghToken,
        body: { body: `🔄 Detected newer upstream update (\`${signature}\`). Issue description updated.` },
      });
      console.log(`Updated GitHub issue #${existingIssueNumber}`);
    } else {
      const created = await ghApi(`/repos/${ghRepo}/issues`, {
        method: 'POST',
        token: ghToken,
        body: { title, body },
      });
      console.log(`Created GitHub issue #${created.json?.number || '?'}`);
    }
  }

  if (tgToken && tgChatId) {
    const msg = watcher.formatTelegramMessage(report, ghRepo || 'koeurnDev/RG');
    const tgRes = await watcher.sendTelegramAlert({ botToken: tgToken, chatId: tgChatId, message: msg });
    console.log(`Sent Telegram alert (messageId=${tgRes.messageId})`);
  } else {
    console.log('Telegram alert skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured).');
  }

  return { notified: true, signature };
}

(async () => {
  if (args.has('--test-telegram')) {
    const tgCfg = watcher.loadTelegramConfigFromEnvFile();
    if (!tgCfg.botToken || !tgCfg.chatId) {
      throw new Error('រកមិនឃើញ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ក្នុង env ឬ lib/.env ទេ');
    }
    const report = await watcher.checkAllUpstreams({ force: true });
    const statusLine = report.hasUpdates
      ? report.summaryText
      : '✅ កូដ HongGuo របស់ EZA PRO កំពុង sync ថ្មីបំផុត (v7.8 / video_tab V5 GET) ហើយ!';
    const text = [
      `🤖 <b>EZA PRO Admin Watcher ដំណើរការជោគជ័យ!</b>`,
      ``,
      statusLine,
      `📦 Repos កំពុងតាមដាន៖ ${(report.repos || []).map((r) => `<code>${r.repo}</code>`).join(', ')}`,
    ].join('\n');
    const res = await watcher.sendTelegramAlert({
      botToken: tgCfg.botToken,
      chatId: tgCfg.chatId,
      message: text,
    });
    console.log(`Telegram test alert sent (messageId=${res.messageId})`);
    return;
  }

  if (args.has('--sync')) {
    const { state, report } = await watcher.syncUpstreamState();
    console.log('Synced upstream-sync.json at', state.updatedAt);
    for (const r of report.repos) {
      console.log(`  - ${r.repo}: sha=${r.latestShortSha || r.syncedSha} release=${r.latestReleaseTag || r.syncedRelease || '-'}`);
    }
    return;
  }

  const report = await watcher.checkAllUpstreams({ force: true });

  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[Upstream Check] ${report.checkedAt}`);
    for (const r of report.repos) {
      const status = r.error ? `ERR (${r.error})` : r.hasUpdate ? 'UPDATE AVAILABLE' : 'UP TO DATE';
      console.log(`- ${r.repo} [${status}]`);
      console.log(`  synced : sha=${r.syncedSha.slice(0, 7) || '-'} | release=${r.syncedRelease || '-'}`);
      console.log(`  latest : sha=${r.latestShortSha || '-'} | release=${r.latestReleaseTag || '-'} | ${r.latestMessage || ''}`);
      if (r.changedFiles.length) {
        console.log(`  changed: ${r.changedFiles.join(', ')}`);
      }
    }
    console.log(report.summaryText);
  }

  if (args.has('--notify') && report.hasUpdates) {
    await notifyIfNew(report);
  }

  if (args.has('--fail-on-update') && report.hasUpdates) {
    process.exitCode = 2;
  }
})().catch((err) => {
  console.error('[Upstream Check Error]', err.message);
  process.exit(1);
});
