const { pathToFileURL, fileURLToPath } = require('node:url');

function createRendererSecurity(entryFile, devUrl) {
  const fileIdentity = url => {
    if (url.protocol !== 'file:' || url.search) return null;
    let file = fileURLToPath(url);
    // Chromium uppercases Windows drives and may spell unreserved characters without escapes.
    if (process.platform === 'win32') file = file.replace(/^[a-z]:/i, drive => drive.toUpperCase());
    return pathToFileURL(file).href;
  };
  const entry = fileIdentity(pathToFileURL(entryFile));
  const devOrigin = devUrl ? new URL(devUrl).origin : '';
  const isTrustedUrl = value => {
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      url.hash = '';
      return fileIdentity(url) === entry || (!!devOrigin && /^https?:$/.test(url.protocol) && url.origin === devOrigin);
    } catch (_) { return false; }
  };
  return {
    isTrustedUrl,
    isTrustedSender(event, win) {
      return !!win && !win.isDestroyed() && event?.sender === win.webContents
        && !!event.senderFrame && event.senderFrame === win.webContents.mainFrame
        && isTrustedUrl(event.senderFrame.url);
    },
    protectWindow(win) {
      for (const name of ['will-navigate', 'will-redirect']) {
        win.webContents.on(name, (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
      }
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    },
  };
}

module.exports = { createRendererSecurity };
