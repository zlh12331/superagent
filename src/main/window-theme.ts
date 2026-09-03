// src/main/window-theme.ts
// 窗口标题栏主题联动（纯 Electron 依赖，无 service-container 依赖）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-03 回归修复）：22aea39 把 syncTitleBarOverlayFromTheme 放进
// window.ts（import service-container → electron-updater 初始化链），导致
// settings.handler.test.ts（IPC 层单测）在纯 Node 环境加载 electron-updater
// 崩溃（NsisUpdater 构造读 app.getVersion()）。
// 本模块收敛"主题 → 窗口控件色"的关注点：只依赖 electron 的 nativeTheme/
// BrowserWindow，settings.handler（IPC 层）与 window.ts（UI shell 层）均可
// 安全引用，不再穿透到服务容器。
// ──────────────────────────────────────────────────────────────

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
      // 透明底：让顶栏玻璃背景统一延伸（深色实底会形成突兀黑块）
      color: '#00000000',
      symbolColor: resolved === 'dark' ? TITLE_BAR_SYMBOL.dark : TITLE_BAR_SYMBOL.light,
    });
  } catch {
    // 部分 Windows 版本/窗口态下 API 可能抛错（非致命，控件色退化为创建时配置）
    // 静默：本模块刻意不依赖 logger（IPC 层测试环境无需日志副作用）
  }
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
