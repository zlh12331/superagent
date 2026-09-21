// src/main/main-events.ts
// 主进程 → 渲染层的状态变更广播（仅在「主进程主动写入」时调用）
// ──────────────────────────────────────────────────────────────
// 为什么需要（docs/design/30-residency-fix-spec.md §3 P2-6）：
// 设置项的正常写入路径是渲染层 → `settings:set` → SQLite，渲染层 store 即真源。
// 但托盘菜单会在**主进程侧直接写入**（如「关闭时最小化到托盘」改 window.closeAction）。
// 此时渲染层 store 仍持旧值 ⇒ ① 设置页显示错误；② 后续任何其它设置变更都会把
// store 里的旧值整体写回，静默覆盖主进程的改动（丢更新）。
//
// 故主进程主动写入后必须广播：渲染层收到即更新对应状态（不回写、不回声）。
// 渲染层自身发起的写入**不需要**广播——其 IPC 响应已是写后回读的真实值。
//
// 广播形态与 deep-link.ts 的 broadcastDeepLink 一致（遍历窗口 + isDestroyed 守卫）。
// ──────────────────────────────────────────────────────────────

import { IPC_CHANNELS } from '@code-agent/shared/ipc/channels';

import type { LoginItemChangedPayload } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

/**
 * 广播「开机自启状态已变更」（payload 为写入后的真实回读值）
 *
 * 调用点：托盘菜单切换自启之后（见 tray.ts → index.ts 的 setAutostart 装配）。
 */
export function broadcastLoginItemChanged(payload: LoginItemChangedPayload): void {
  const channel = IPC_CHANNELS['APP_EVENT_LOGIN_ITEM_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * 广播「某个设置域已被主进程变更」（payload 为该域完整新值）
 *
 * 调用点：托盘菜单切换关窗行为之后（见 index.ts 的 setCloseAction 装配）。
 */
export function broadcastSettingChanged(key: string, value: unknown): void {
  const channel = IPC_CHANNELS['SETTINGS_EVENT_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, { key, value });
    }
  }
}
