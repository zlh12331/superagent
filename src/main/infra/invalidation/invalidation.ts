import type { InvalidationPayload } from '@code-agent/shared/main';
import { IPC_CHANNELS, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

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

function collectWindows(): readonly BrowserWindow[] {
  try {
    return BrowserWindow.getAllWindows();
  } catch {
    return [];
  }
}
