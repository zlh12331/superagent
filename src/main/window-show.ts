import { BrowserWindow } from 'electron';

import { logger } from './utils/logger';

/** 窗口当前虽隐藏、但下次唤回时应回到最大化态（仅"静默启动且上次为最大化"时为 true） */
let maximizeOnNextShow = false;

/** 标记「下次唤回时最大化」（由 window.ts 在静默启动路径调用） */
export function markMaximizeOnNextShow(): void {
  maximizeOnNextShow = true;
}

/**
 * 把主窗口带到用户眼前
 *
 * 有窗口则 restore（仅最小化时）→ 应用 pending 最大化 → show → focus。
 * 无窗口（macOS 关窗后窗口被销毁）或无可用窗口时返回 false，由调用方决定是否重建。
 *
 * 本应用单窗口（既有代码全部以 `getAllWindows()[0]` 为准），故 pending 标志用模块级变量。
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
 * 唤回主窗口；窗口不存在时用 create() 重建
 *
 * 供三处共用（同一语义，勿再各写一份）：
 * - Dock 点击（macOS `activate`）
 * - 二次启动 / 协议唤起（`second-instance`）
 * - 托盘左键与菜单（`tray.ts`）
 */
export function bringMainWindowToFront(create: () => void): void {
  if (!showMainWindow()) {
    logger.info({}, '主窗口不存在，重建窗口后唤回');
    create();
  }
}
