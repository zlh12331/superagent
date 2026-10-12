// main-events.ts：主进程 → 渲染层的零散状态事件广播
// 边界：只做通道投递；回合/工具流式事件走各自的 stream 通道，不经这里
import { IPC_CHANNELS } from '@code-agent/shared/ipc/channels';

import type { LoginItemChangedPayload } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

/** 广播「开机自启状态已变更」（payload 为写入后的真实回读值；托盘切换自启后调用） */
export function broadcastLoginItemChanged(payload: LoginItemChangedPayload): void {
  const channel = IPC_CHANNELS['APP_EVENT_LOGIN_ITEM_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/** 广播设置键变更（渲染层据此同步非本窗口发起的修改，如托盘切关窗行为；key 为 settings 域键名） */
export function broadcastSettingChanged(key: string, value: unknown): void {
  const channel = IPC_CHANNELS['SETTINGS_EVENT_CHANGED'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, { key, value });
    }
  }
}
