// window-theme.ts：win32 标题栏 overlay 的明暗联动——frameless 窗口原生标题栏图标配色随主题切换
// 边界：仅 Windows 生效（setTitleBarOverlay 是 win32 能力）；主题解析入口在 nativeTheme updated 事件（index.ts）
import { BrowserWindow, nativeTheme } from 'electron';

/** 标题栏 overlay 图标色：亮/暗主题各一档（与渲染层中性色阶对齐的硬编码值） */
export const TITLE_BAR_SYMBOL = {
  dark: '#a8a29e',
  light: '#57534e',
} as const;

/**
 * 按已解析主题应用标题栏 overlay 配色
 *
 * try/catch 静默：窗口早期生命周期或系统不支持时 setTitleBarOverlay 会抛错，不值得为此失败
 */
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

/**
 * 从 settings 的 theme 原始值解析出明暗并应用
 *
 * 值容错回 'dark'（未知值不当亮色）；'system' 经 nativeTheme.shouldUseDarkColors 解析
 */
export function syncTitleBarOverlayFromTheme(theme: unknown): void {
  const t = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark';
  const resolved = t === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : t;
  applyTitleBarOverlayTheme(resolved);
}
