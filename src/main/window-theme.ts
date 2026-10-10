import { BrowserWindow, nativeTheme } from 'electron';

/** Windows/Linux 窗口控件（最小化/最大化/关闭）符号色 —— 按主题切换 */
export const TITLE_BAR_SYMBOL = {
  /** stone-400：暗色玻璃背景上清晰可见（纯黑会隐身） */
  dark: '#a8a29e',
  /** stone-600：亮色背景上清晰可见（与 stone-400 同色系加深） */
  light: '#57534e',
} as const;

/**
 * 应用主题化窗口控件色（titleBarOverlay）
 *
 * 仅 Windows 支持 setTitleBarOverlay 运行时更新（Linux 的 WCO 无此 API，
 * macOS 红绿灯由系统绘制不需要）——其余平台静默跳过。
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
 * 按用户主题设置解析并应用窗口控件色
 *
 * 主进程收口点：settings:set（渲染层切主题）/ settings:getAll（启动校正）/
 * nativeTheme updated（system 模式 OS 切换）三个事件统一走此函数。
 * 'system' 用主进程 nativeTheme 解析（与渲染层 matchMedia 同源信号）。
 */
export function syncTitleBarOverlayFromTheme(theme: unknown): void {
  const t = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark';
  const resolved = t === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : t;
  applyTitleBarOverlayTheme(resolved);
}
