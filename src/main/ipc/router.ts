// src/main/ipc/router.ts
// IPC 路由：统一注册所有 handler
//
// 设计文档 §4.1 分层架构：IPC Handlers 是薄层（参数校验 + 调 service）
// 本模块汇总所有域的 register 函数，供 main/index.ts 在 app.whenReady() 后调用
//
// 注册的 9 个域共 38 个 channel：
// - project（6）/ chapter（6）/ character（6）/ worldview（4）
// - chat（5）/ rag（4）/ agent（3）/ settings（4）/ app（2）

import { logger } from '../utils/logger';
import { registerAgentHandlers } from './handlers/agent.handler';
import { registerAppHandlers } from './handlers/app.handler';
import { registerChapterHandlers } from './handlers/chapter.handler';
import { registerCharacterHandlers } from './handlers/character.handler';
import { registerChatHandlers } from './handlers/chat.handler';
import { registerProjectHandlers } from './handlers/project.handler';
import { registerRagHandlers } from './handlers/rag.handler';
import { registerSettingsHandlers } from './handlers/settings.handler';
import { registerWorldviewHandlers } from './handlers/worldview.handler';

/**
 * 注册所有 IPC handler
 *
 * 在 app.whenReady() 后、数据库初始化完成后调用。
 * 注册全部 9 个域共 38 个 channel 的 handler。
 *
 * 幂等：重复调用安全（ipcMain.handle 对同一 channel 重复注册会抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次）。
 */
export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerChapterHandlers();
  registerCharacterHandlers();
  registerWorldviewHandlers();
  registerChatHandlers();
  registerRagHandlers();
  registerAgentHandlers();
  registerSettingsHandlers();
  registerAppHandlers();
  logger.info({}, 'IPC handler 全部注册完成（9 域 38 channel）');
}
