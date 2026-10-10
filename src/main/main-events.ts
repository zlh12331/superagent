import { IPC_CHANNELS } from '@code-agent/shared/ipc/channels';

import type { LoginItemChangedPayload } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

export function broadcastLoginItemChanged(payload: LoginItemChangedPayload): void {
  const channel = IPC_CHANNELS['APP_EVENT_LOGIN_ITEM_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function broadcastSettingChanged(key: string, value: unknown): void {
  const channel = IPC_CHANNELS['SETTINGS_EVENT_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, { key, value });
    }
  }
}
