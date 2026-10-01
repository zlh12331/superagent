// src/main/window-show.ts
// 主窗口唤回的唯一实现（show / 首次唤回时最大化 / 无窗口时重建）
// ──────────────────────────────────────────────────────────────
// 为什么独立成模块：这条逻辑此前有三份副本，且行为不一致——
//   · tray.ts:183-193        restore → show → focus（正确）
//   · notification.ts:82-91  restore → show → focus（正确，属复制）
//   · index.ts:130-133       restore（仅最小化时）→ focus（**缺 show**）
// 第三份导致「静默驻留托盘后，点桌面图标/开始菜单唤不出窗口」（2026-09-21 真机实测）。
//
// 为什么不实现放在 tray.ts 再导出：window.ts 已 import ./tray（取 notifyMinimizedToTray），
// 若 tray 反向 import window 即构成循环依赖。本模块只依赖 electron 与 logger，是叶子节点，
// window.ts / index.ts / tray.ts / notification.ts 各自 import 均无环。
//
// 静默启动的配套：window.ts 在 startHidden 时不显示窗口，此时**不能**调用 maximize()——
// Electron 的 maximize() 自身会显示窗口（electron.d.ts:3101「will also show (but not focus)
// the window if it isn't being displayed already」），这正是"上次最大化过 ⇒ --hidden 失效"
// 的成因。改为记下 pending 标志，由本模块在用户首次唤回时应用：maximize 同时完成"显示"与
// "回到最大化态"，且不会先显示普通尺寸再跳变。
// ──────────────────────────────────────────────────────────────

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
    // maximize() 自带"显示未显示的窗口"语义，故无需先 show()；先 show 会看到普通尺寸跳变
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
