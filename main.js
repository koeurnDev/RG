/**
 * EZA PRO Downloader - Electron Desktop Main Process
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let serverHandle = null;

function isWritableDirectory(dirPath) {
  if (!dirPath) return false;
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.eza-probe-${process.pid}.tmp`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveDefaultDownloadDir(userDataDir) {
  let downloadsDir = '';
  try {
    downloadsDir = app.getPath('downloads') || '';
  } catch (_) {}
  const candidates = [
    downloadsDir ? path.join(downloadsDir, 'EZA PRO Downloader') : '',
    path.join(userDataDir, 'Downloads'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (isWritableDirectory(dir)) return dir;
  }
  return path.join(userDataDir, 'Downloads');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function configurePackagedPaths() {
  if (!app.isPackaged) return;
  const userDataDir = app.getPath('userData');

  process.env.EZA_PACKAGED_CLIENT = '1';
  process.env.HDRG_ISOLATED = '1';
  process.env.EZA_USER_DATA_DIR = process.env.EZA_USER_DATA_DIR || userDataDir;
  process.env.HDRG_CONFIG_FILE = process.env.HDRG_CONFIG_FILE || path.join(userDataDir, 'config.json');
  process.env.EZA_DEFAULT_DOWNLOAD_DIR =
    process.env.EZA_DEFAULT_DOWNLOAD_DIR || resolveDefaultDownloadDir(userDataDir);
  process.env.EZA_BIN_DIR = process.env.EZA_BIN_DIR || path.join(process.resourcesPath, 'bin');
}

function createWindow(port) {
  const allowDevTools =
    !app.isPackaged &&
    process.env.NODE_ENV === 'development' &&
    process.env.EZA_LOCK_DEVTOOLS !== '1';

  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    title: `EZA PRO v${app.getVersion()}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0b0f17',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: allowDevTools
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  if (allowDevTools) {
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toUpperCase();
      const isInspectShortcut =
        key === 'F12' ||
        ((input.control || input.meta) && input.shift && (key === 'I' || key === 'J' || key === 'C')) ||
        ((input.control || input.meta) && key === 'U');
      if (isInspectShortcut) {
        event.preventDefault();
      }
    });
  }

  let showFallbackTimer = null;
  const showWindow = () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  showFallbackTimer = setTimeout(showWindow, 2500);
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.webContents.once('did-finish-load', showWindow);
  mainWindow.on('closed', () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    configurePackagedPaths();
    const uiServer = require('./ui_server');
    if (typeof uiServer.setFolderPickerHandler === 'function') {
      uiServer.setFolderPickerHandler(async (initialPath) => {
        const res = await dialog.showOpenDialog(mainWindow || undefined, {
          title: 'EZA PRO - ជ្រើសថតរក្សាទុកវីដេអូ',
          defaultPath: initialPath || undefined,
          properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
        return res.filePaths[0];
      });
    }

    const started = await uiServer.startServer({ port: 0, host: '127.0.0.1', warmUp: true });
    serverHandle = uiServer;
    createWindow(started.port);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
        createWindow(started.port);
      }
    });
  }).catch((err) => {
    console.error('[EZA PRO Downloader] Startup error:', err);
    dialog.showErrorBox('EZA PRO Downloader Startup Error', err && err.message ? err.message : String(err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (serverHandle && typeof serverHandle.stopServer === 'function') {
        serverHandle.stopServer();
      }
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (serverHandle && typeof serverHandle.stopServer === 'function') {
      serverHandle.stopServer();
    }
  });
}

