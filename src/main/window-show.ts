// window-show.ts：主窗口唤起——显示/还原/聚焦，窗口不存在时交由调用方重建
// 与 window.ts 的分工：这里只管「把已有窗口带回前台」，创建/销毁/内容加载都在 window.ts
import { BrowserWindow } from 'electron';

import { logger } from './utils/logger';

// 「下次显示时最大化」一次性标记：窗口常以隐藏态创建（开机自启/关到托盘），
// 创建路径记下最大化意图，由 showMainWindow 消费后清零
let maximizeOnNextShow = false;

/** 记录「下次显示时最大化」意图（一次性，showMainWindow 消费后自动清除） */
export function markMaximizeOnNextShow(): void {
  maximizeOnNextShow = true;
}

/**
 * 把主窗口带回前台：最小化先还原，再按标记最大化，最后 show + focus
 *
 * @returns true = 已有窗口并完成唤起；false = 窗口不存在（调用方决定是否重建）
 */
export function showMainWindow(): boolean {
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined || win.isDestroyed()) {
    return false;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  if (maximizeOnNextShow) {
    maximizeOnNextShow = false;
    win.maximize();
  }
  win.show();
  win.focus();
  return true;
}

/**
 * 唤回主窗口；窗口已不存在（被关掉/崩溃）则走调用方给的 create 重建
 *
 * activate（macOS 点 Dock）与 second-instance 都经这里收口
 */
export function bringMainWindowToFront(create: () => void): void {
  if (!showMainWindow()) {
    logger.info({}, '主窗口不存在，重建窗口后唤回');
    create();
  }
}
