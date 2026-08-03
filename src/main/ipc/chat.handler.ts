// src/main/ipc/chat.handler.ts
// 聊天域 IPC handler（Vercel AI SDK v7）
//
// 注册 2 个请求-响应 channel：
// - chat:send：发起对话，返回 sessionId（渲染层用此 id 订阅后续流式事件）
// - chat:stop：中断指定 sessionId 的对话
//
// 流式事件由 ChatService 主动推送（不在此 handler 返回）：
// - chat:stream:part：逐 part 推送 UIMessageStreamPart
// - chat:stream:end：流正常结束
// - chat:stream:error：流异常结束（含 code + message）
//
// 设计文档 §4.7 IPC handler 设计 / §5.3 完整 Channel 清单
//
// P0-2 改造：
// - 接受 IChatService 依赖注入，handler 不再直接 import 模块级单例
// - 通过 ServiceContainer 在 app.whenReady 时注入实例
// - 便于测试：可注入 mock chatService，不依赖真实 streamText
//
// P0-3 改造：
// - zod schema 从 @code-agent/shared 导入，不再在 handler 内联定义
// - schema 与类型同源（payloads.ts 类型从 schema 派生），消除双向漂移风险

import {
  type ChatSendReq,
  ChatSendReqSchema,
  type ChatSendRes,
  type ChatStopReq,
  ChatStopReqSchema,
  type ChatStopRes,
  IPC_CHANNELS,
} from '@code-agent/shared/main';
import type { IChatService } from '../infra/ai/chat-service';
import { wrap } from '../utils/wrap';

/**
 * 聊天域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 ChatService 实现：
 * - 生产环境：ServiceContainer 注入默认 ChatService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实 streamText / 网络
 */
export interface ChatHandlerDeps {
  /** ChatService 实例（来自 ServiceContainer） */
  readonly chatService: IChatService;
}

/**
 * 注册聊天域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerAppHandlers 并列。
 *
 * @param deps 依赖项：包含 IChatService 实例（由 ServiceContainer 注入）
 *
 * 幂等：重复调用会抛错（ipcMain.handle 对同一 channel 重复注册），
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerChatHandlers(deps: ChatHandlerDeps): void {
  const { chatService } = deps;

  // 发起对话：启动 streamText 流，立即返回 sessionId（流式 part 通过 CHAT_STREAM_PART 推送）
  wrap<ChatSendReq, ChatSendRes>(IPC_CHANNELS.CHAT_SEND, ChatSendReqSchema, async (input, ctx) => {
    const sessionId = await chatService.startChat({
      messages: input.messages,
      sessionId: input.sessionId,
      webContents: ctx.sender,
    });
    return { sessionId };
  });

  // 中断对话：触发 AbortController.abort()，流推送协程会捕获 AbortError 并推送 CHAT_STREAM_END
  wrap<ChatStopReq, ChatStopRes>(IPC_CHANNELS.CHAT_STOP, ChatStopReqSchema, async (input) => {
    const stopped = chatService.abort(input.sessionId);
    return { stopped };
  });
}
