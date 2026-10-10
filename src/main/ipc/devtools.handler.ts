import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/** devtools:open 默认 mode（独立窗口，不占用应用主窗口空间） */
const DEFAULT_MODE: 'detach' | 'right' | 'bottom' = 'detach';

/** DevTools 域 handler 实现 */
export const devtoolsHandlers: InferHandlers<
  typeof IPC_DEFINITIONS,
  IpcHandlerContext
>['devtools'] = {
  open: async (input, ctx) => {
    const mode = input?.mode ?? DEFAULT_MODE;
    const win = BrowserWindow.fromWebContents(ctx.sender);

    if (win === null) {
      logger.warn({ traceId: ctx.traceId }, 'DevTools 打开失败：sender 窗口不存在');
      return { ok: false, mode };
    }

    win.webContents.openDevTools({ mode });
    logger.info({ traceId: ctx.traceId, mode }, 'DevTools 已打开');

    return { ok: true, mode };
  },
};
