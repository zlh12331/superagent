// src/main/ipc/handlers/chat.handler.ts
// AI 对话域 IPC handler（薄层）
// 设计文档 §4.1 分层架构 / §5.1 场景 3（AI 流式对话）/ §5.3 完整 Channel 清单
//
// 职责：
// 1. 注册 chat 域 6 个 channel 的 handler（createSession / listSessions / getMessages / sendMessage / stopGeneration / deleteSession）
// 2. sendMessage：持久化用户消息 → 后台启动 AI 生成 → 立即返回 ackId
// 3. deleteSession：先 abort 活跃流再级联删除会话与消息
// 4. 不做业务逻辑，仅参数校验（wrap 内置 zod）+ 调 service
//
// 注意：
// - runChatGeneration 使用 sessionId 作为 streamId，通过 stream-bridge 推送 chunk/end/error 事件
// - sendMessage handler 不 await runChatGeneration（后台异步执行，立即返回 ackId 给渲染层）

import {
  ChatSendMessageInputSchema,
  ChatSessionCreateInputSchema,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import { z } from 'zod';
import { runChatGeneration } from '../../services/agent.service';
import {
  createChatSession,
  deleteChatSession,
  getChatMessages,
  listChatSessions,
  sendChatMessage,
  stopChatGeneration,
} from '../../services/chat.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 chat 域 IPC handler
 *
 * 6 个 channel：
 * - chat:createSession   → createChatSession
 * - chat:listSessions    → listChatSessions
 * - chat:getMessages     → getChatMessages
 * - chat:sendMessage     → sendChatMessage + 后台 runChatGeneration
 * - chat:stopGeneration  → stopChatGeneration
 * - chat:deleteSession   → deleteChatSession（级联删除消息）
 */
export function registerChatHandlers(): void {
  // 创建对话会话（projectId / title 必填，model 可选）
  wrap(IPC_CHANNELS.CHAT_CREATE_SESSION, ChatSessionCreateInputSchema, (input) =>
    createChatSession(input),
  );

  // 列出项目下所有会话（按 updatedAt 倒序）
  wrap(IPC_CHANNELS.CHAT_LIST_SESSIONS, z.object({ projectId: z.string().min(1) }), (input) =>
    listChatSessions(input.projectId),
  );

  // 获取会话消息列表（按 createdAt 升序）
  wrap(IPC_CHANNELS.CHAT_GET_MESSAGES, z.object({ sessionId: z.string().min(1) }), (input) =>
    getChatMessages(input.sessionId),
  );

  // sendMessage：持久化用户消息 → 后台启动 AI 生成 → 立即返回 ackId
  //
  // 流程：
  // 1. sendChatMessage 校验会话存在 + 持久化 user 消息 + 返回 ackId
  // 2. runChatGeneration 后台异步执行（不 await）：
  //    - 读取项目 AI 设置 + RAG 检索 + 历史消息 → DeepSeek 流式生成
  //    - 通过 stream-bridge 推送 chat:stream:chunk / end / error 事件
  //    - 流结束后持久化 assistant 消息
  // 3. handler 立即返回 { ackId }，渲染层用 ackId/sessionId 关联流式事件
  wrap(IPC_CHANNELS.CHAT_SEND_MESSAGE, ChatSendMessageInputSchema, async (input, ctx) => {
    const { ackId } = await sendChatMessage(input);
    // void 标注：后台执行不等待，避免未处理 rejection 警告
    // webContents = ctx.sender，stream-bridge 通过它向发起请求的窗口推送事件
    void runChatGeneration({ sessionId: input.sessionId, webContents: ctx.sender });
    return { ackId };
  });

  // 停止 AI 生成（通过 StreamBridge 中断 sessionId 对应的活跃流）
  wrap(IPC_CHANNELS.CHAT_STOP_GENERATION, z.object({ sessionId: z.string().min(1) }), (input) =>
    stopChatGeneration(input.sessionId),
  );

  // 删除会话（级联删除消息 + 中断活跃 AI 流）
  // service 内部处理：findUnique 校验存在 → bridge.has 时 abort → prisma.delete（级联）
  wrap(IPC_CHANNELS.CHAT_DELETE_SESSION, z.object({ id: z.string().min(1) }), (input) =>
    deleteChatSession(input.id),
  );
}
