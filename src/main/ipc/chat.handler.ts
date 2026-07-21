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

import {
  type ChatSendReq,
  type ChatSendRes,
  type ChatStopReq,
  type ChatStopRes,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import { z } from 'zod';
import { getChatService } from '../infra/ai/chat-service';
import { wrap } from '../utils/wrap';

/**
 * ChatMessage zod schema
 *
 * 与 shared.ChatMessage 接口保持一致，用于校验 IPC 入参。
 * 共享包目前不导出 zod schema（保持轻量），handler 内联定义避免依赖膨胀。
 */
const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
});

/**
 * chat:send 入参 schema
 *
 * sessionId 用 `.optional().transform(v => v ?? undefined)`：
 * - 运行时允许字段缺失（渲染层首次发起对话时不传 sessionId）
 * - transform 把缺失值统一转为 undefined，让 output 类型为 `string | undefined`（必填字段，值可为 undefined）
 *
 * 这样与 shared.ChatSendReq.sessionId: `string | undefined` 类型完全对齐，
 * 兼容 exactOptionalPropertyTypes 严格模式（避免 `?: string | undefined` 与 `string | undefined` 不兼容）。
 */
const ChatSendReqSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  sessionId: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/**
 * chat:stop 入参 schema
 */
const ChatStopReqSchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * 注册聊天域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerAppHandlers 并列。
 *
 * 幂等：重复调用会抛错（ipcMain.handle 对同一 channel 重复注册），
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerChatHandlers(): void {
  // 发起对话：启动 streamText 流，立即返回 sessionId（流式 part 通过 CHAT_STREAM_PART 推送）
  wrap<ChatSendReq, ChatSendRes>(IPC_CHANNELS.CHAT_SEND, ChatSendReqSchema, async (input, ctx) => {
    const sessionId = await getChatService().startChat({
      messages: input.messages,
      sessionId: input.sessionId,
      webContents: ctx.sender,
    });
    return { sessionId };
  });

  // 中断对话：触发 AbortController.abort()，流推送协程会捕获 AbortError 并推送 CHAT_STREAM_END
  wrap<ChatStopReq, ChatStopRes>(IPC_CHANNELS.CHAT_STOP, ChatStopReqSchema, async (input) => {
    const stopped = getChatService().abort(input.sessionId);
    return { stopped };
  });
}
