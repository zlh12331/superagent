// src/main/ipc/app.handler.ts
// 应用级 IPC handler
//
// 当前仅注册 2 个应用级 channel：
// - app:getStatus：返回应用就绪状态（health check）
// - app:openExternal：通过系统浏览器打开外链
//
// 说明：业务相关 handler（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随数据库层一并删除，作为 Electron 模板基础设施仅保留应用级 handler。

import { IPC_CHANNELS, type IpcResponse } from '@novel-writer/shared';
import { ipcMain, shell } from 'electron';
import { logger } from '../utils/logger';

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
  ipcMain.handle(IPC_CHANNELS.APP_GET_STATUS, (): IpcResponse<{ ready: boolean }> => {
    return { data: { ready: true } };
  });

  // 外链打开：通过系统浏览器打开
  ipcMain.handle(
    IPC_CHANNELS.APP_OPEN_EXTERNAL,
    async (_event, payload: { url: string }): Promise<IpcResponse<{ ok: boolean }>> => {
      const url = payload?.url;
      if (typeof url !== 'string' || url === '') {
        return { error: { code: 'INVALID_INPUT', message: 'URL 不能为空' } };
      }
      // 仅允许 http/https 协议，防止 file:// / javascript: 等危险协议
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { error: { code: 'INVALID_INPUT', message: '仅允许 http/https 协议' } };
      }
      try {
        await shell.openExternal(url);
        return { data: { ok: true } };
      } catch (err) {
        logger.error({ error: err, url }, '打开外链失败');
        return { error: { code: 'INTERNAL_ERROR', message: '打开外链失败' } };
      }
    },
  );

  logger.info({}, '应用级 IPC handler 注册完成（2 channel）');
}
