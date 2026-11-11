// 红果短剧 4.8：界面入口；目录双线与验证范围见 docs/release-4.8.md。
// Browser fallback mock for window.electronAPI when previewing in a regular web browser
if (typeof window !== 'undefined' && !window.electronAPI) {
  window.electronAPI = new Proxy({
    platform: 'browser',
    getSettings: () => Promise.resolve({ download_quality: 'auto', picture_in_picture_mode: 'custom' }),
    getAppInfo: () => Promise.resolve({ version: '6.9.0', systemLocale: navigator?.language || 'zh-CN' }),
    getMediaSources: () => Promise.resolve({
      success: true,
      sources: [
        { id: 'hongguo', label: '红果短剧' },
        { id: 'xifan', label: '西饭短剧' },
        { id: 'hema', label: '河马短剧' }
      ]
    }),
    getWindowLayout: () => Promise.resolve('landscape'),
    getAlwaysOnTop: () => Promise.resolve(false),
    getWatchHistory: () => Promise.resolve([]),
    getDownloadTasks: () => Promise.resolve([]),
    getCurrentAnnouncement: () => Promise.resolve(null),
    getAppUpdateState: () => Promise.resolve({}),
    getBossKeyState: () => Promise.resolve({}),
    getPublicDetails: () => Promise.resolve({}),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return () => () => {};
      }
      return () => Promise.resolve({ success: true });
    }
  });
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import { initializePosterSize } from './theme';

import { initializeLanguage } from './i18n';

initializePosterSize();


initializeLanguage().then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
));
