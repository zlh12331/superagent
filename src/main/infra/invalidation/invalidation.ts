// invalidation.ts：跨进程缓存失效广播——主进程数据变更后通知渲染层按域失效 TanStack Query 缓存
// 31 号：memory/IM 两域缺口已收口至此；调用方在数据写路径上显式点名失效域
import type { InvalidationPayload } from '@code-agent/shared/main';
import { IPC_CHANNELS, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/**
 * 向所有窗口广播失效域（domains 空 / 无窗口时静默跳过）
 *
 * @param sessionId 可选——渲染层可据此只失效该会话相关的 queryKey
 */
export function broadcastInvalidation(domains: readonly string[], sessionId?: string): void {
  if (domains.length === 0) {
    return;
  }
  const windows = collectWindows();
  if (windows.length === 0) {
    return;
  }
  const payload: InvalidationPayload = {
    domains,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  for (const win of windows) {
    if (!win.isDestroyed()) {
      emitEvent(win.webContents, IPC_DEFINITIONS.invalidation.subscribeDomains, payload);
    }
  }
  logger.debug(
    { domains, sessionId, channel: IPC_CHANNELS['INVALIDATION_EVENT_DOMAINS'] },
    '失效域已广播',
  );
}

// getAllWindows 在应用退出竞态下可能抛（app 正在销毁）——失效广播是尽力而为，吞掉即可
function collectWindows(): readonly BrowserWindow[] {
  try {
    return BrowserWindow.getAllWindows();
  } catch {
    return [];
  }
}
