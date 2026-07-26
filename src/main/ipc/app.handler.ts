// src/main/ipc/app.handler.ts
// 应用级 IPC handler
//
// 当前仅注册 2 个应用级 channel：
// - app:getStatus：返回应用就绪状态（health check）
// - app:openExternal：通过系统浏览器打开外链
//
// 说明：业务相关 handler（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随数据库层一并删除，作为 Electron 模板基础设施仅保留应用级 handler。

import { AppError, ErrorCode, IPC_CHANNELS } from '@novel-writer/shared';
import { shell } from 'electron';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { wrap } from '../utils/wrap';

/**
 * 注册应用级 IPC handler
 *
 * 在 app.whenReady() 后调用一次。
 *
 * 幂等：重复调用会抛错（ipcMain.handle 对同一 channel 重复注册），
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerAppHandlers(): void {
  // 应用状态查询：返回就绪标记
  wrap<undefined, { ready: boolean }>(
    IPC_CHANNELS.APP_GET_STATUS,
    null,
    async (): Promise<{ ready: boolean }> => {
      return { ready: true };
    },
  );

  // 外链打开：通过系统浏览器打开
  const openExternalSchema = z.object({
    url: z.string().min(1, 'URL 不能为空'),
  });

  wrap<{ url: string }, { ok: boolean }>(
    IPC_CHANNELS.APP_OPEN_EXTERNAL,
    openExternalSchema,
    async (input: { url: string }): Promise<{ ok: boolean }> => {
      // 仅允许 http/https 协议，防止 file:// / javascript: 等危险协议
      if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
        throw new AppError(ErrorCode.INVALID_INPUT, '仅允许 http/https 协议');
      }
      await shell.openExternal(input.url);
      return { ok: true };
    },
  );

  logger.info({}, '应用级 IPC handler 注册完成（2 channel）');
}
