import { BrowserWindow, nativeTheme } from 'electron';

export const TITLE_BAR_SYMBOL = {
  dark: '#a8a29e',
  light: '#57534e',
} as const;

export function applyTitleBarOverlayTheme(resolved: 'light' | 'dark'): void {
  if (process.platform !== 'win32') {
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined || win.isDestroyed()) {
    return;
  }
  try {
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: resolved === 'dark' ? TITLE_BAR_SYMBOL.dark : TITLE_BAR_SYMBOL.light,
    });
  } catch {}
}

export function syncTitleBarOverlayFromTheme(theme: unknown): void {
  const t = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark';
  const resolved = t === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : t;
  applyTitleBarOverlayTheme(resolved);
}
