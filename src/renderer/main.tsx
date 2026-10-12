import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initRendererErrorHandlers } from '@/lib/error-report';

initRendererErrorHandlers();

if (import.meta.env.MODE === 'web') {
  const { installMockApi } = await import('@/dev/mock-api');
  installMockApi();
}

import { LANGUAGE_STORAGE_KEY } from '@/i18n/config';
import { bootstrapSettings } from '@/lib/settings-bootstrap';
import { applyInitialTheme } from '@/lib/theme-init';
import { applyZoom } from '@/lib/zoom';
import {
  applySettingsSnapshot,
  flushPendingSettings,
  useSettingsStore,
} from '@/stores/persistent/settings-store';

window.addEventListener('pagehide', () => {
  void flushPendingSettings();
});

const { theme, snapshot } = await bootstrapSettings();
applySettingsSnapshot(snapshot);
applyInitialTheme(theme);
await applyZoom(useSettingsStore.getState().appearance.zoom);
const snapshotLanguage = snapshot['language'];
if (typeof snapshotLanguage === 'string') {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, snapshotLanguage);
  } catch {}
}
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('根节点 #root 未找到');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
