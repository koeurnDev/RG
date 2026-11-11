const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Legacy behavior checks use empty events; keep the real production IPC guard active.
module.exports = function installTrustedIpc(context, handlers) {
  const window = vm.runInContext('mainWindow', context) || { webContents: {} };
  window.isDestroyed ||= () => false;
  window.webContents.isDestroyed ||= () => false;
  window.webContents.send ||= () => {};
  window.webContents.mainFrame ||= {
    url: pathToFileURL(path.join(context.__dirname, 'dist-react/index.html')).href,
  };
  context.trustedIpcWindow = window;
  vm.runInContext('mainWindow = trustedIpcWindow', context);
  delete context.trustedIpcWindow;
  for (const [channel, handler] of Object.entries(handlers)) {
    handlers[channel] = (event, ...args) => handler(
      event == null || Object.keys(event).length === 0
        ? { sender: window.webContents, senderFrame: window.webContents.mainFrame }
        : event,
      ...args,
    );
  }
};
