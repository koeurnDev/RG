import { useEffect, useSyncExternalStore } from 'react';
import { BUILTIN_MEDIA_SOURCES, createMediaSourcesStore } from './mediaSourcesModel.mjs';

const store = createMediaSourcesStore(() => (window.electronAPI?.getMediaSources
  ? window.electronAPI.getMediaSources() : Promise.resolve({ success: true, sources: BUILTIN_MEDIA_SOURCES })));
window.addEventListener('custom-sources-changed', () => store.refresh(true));
window.electronAPI?.onMediaSourcesChanged?.(() => store.refresh(true));

export function notifyMediaSourcesChanged() {
  window.dispatchEvent(new Event('custom-sources-changed'));
}
export default function useMediaSources() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.refresh(); }, []);
  return state;
}
