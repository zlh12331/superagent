// src/main/ipc/chat.handler.ts
// 聊天域 IPC handler（Vercel AI SDK v7，定义表驱动）
//
// 实现 2 个请求-响应方法：
// - send：发起对话，返回 sessionId（渲染层用此 id 订阅后续流式事件）
// - stop：中断指定 sessionId 的对话
//
// 流式事件由 ChatService 主动推送（不在此 handler 返回）：
// - chat:stream:part：逐 part 推送 UIMessageStreamPart
// - chat:stream:end：流正常结束
// - chat:stream:error：流异常结束（含 code + message）
//
// 设计：
// - 接受 IChatService 依赖注入，handler 不直接 import 模块级单例
// - 通过 ServiceContainer 在 app.whenReady 时注入实例
// - 便于测试：可注入 mock chatService，不依赖真实 streamText

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IChatService } from '../infra/ai/chat-service';
import type { IpcHandlerContext } from '../utils/wrap';

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
 * 创建聊天域 handler 实现
 *
 * @param deps 依赖项：包含 IChatService 实例（由 ServiceContainer 注入）
 */
export function createChatHandlers(
  deps: ChatHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['chat'] {
  const { chatService } = deps;

  return {
    // 发起对话：启动 streamText 流，立即返回 sessionId（流式 part 通过 CHAT_STREAM_PART 推送）
    send: async (input, ctx) => {
      const sessionId = await chatService.startChat({
        messages: input.messages,
        sessionId: input.sessionId,
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        webContents: ctx.sender,
      });
      return { sessionId };
    },

    // 中断对话：触发 AbortController.abort()，流推送协程会捕获 AbortError 并推送 CHAT_STREAM_END
    stop: async (input) => {
      const stopped = chatService.abort(input.sessionId);
      return { stopped };
    },
  };
}
