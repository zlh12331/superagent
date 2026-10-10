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
