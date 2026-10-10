import { BrowserWindow } from 'electron';

import { logger } from './utils/logger';

let maximizeOnNextShow = false;

export function markMaximizeOnNextShow(): void {
  maximizeOnNextShow = true;
}

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

export function bringMainWindowToFront(create: () => void): void {
  if (!showMainWindow()) {
    logger.info({}, '主窗口不存在，重建窗口后唤回');
    create();
  }
}
