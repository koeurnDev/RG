const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('ezaDesktop', {
  isElectron: true,
  platform: process.platform
});

