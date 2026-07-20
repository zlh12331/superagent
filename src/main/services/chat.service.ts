// src/main/services/chat.service.ts
// AI 对话业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ChatSession / ChatMessage 模型
//
// 职责：
// 1. 对话会话管理（createSession / listSessions / deleteSession）
// 2. 消息管理（getMessages / sendMessage）
// 3. sendChatMessage 持久化用户消息并返回 ackId（实际 AI 调用由 agent.service 编排）
// 4. stopChatGeneration 通过 StreamBridge 单例中断活跃流
// 5. deleteChatSession 删除会话（先 abort 活跃流，再级联删除消息）
// 6. saveAssistantMessage 供 agent.service 在流结束后持久化 assistant 消息
//
// 注意：
// - 不与其他 service 互相依赖
// - AI 流式响应转发由 Phase 5b agent.service + stream-bridge 完成

import { randomUUID } from 'node:crypto';
import {
  AppError,
  type ChatMessage,
  ChatRole,
  type ChatSendMessageInput,
  type ChatSession,
  type ChatSessionCreateInput,
  ErrorCode,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getStreamBridge } from '../infra/ai/stream-bridge';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建对话会话
 *
 * @param input 会话创建入参（projectId / title 必填，model 可选）
 * @returns 创建后的会话（含 id 与时间戳）
 */
export async function createChatSession(input: ChatSessionCreateInput): Promise<ChatSession> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建对话会话');

  // 注意：exactOptionalPropertyTypes 严格模式不允许将 `string | undefined` 赋给可选属性，
  // 故 model 字段使用条件展开，仅在传入时写入，避免 TS2375。
  const created = await prisma.chatSession.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      ...(input.model !== undefined ? { model: input.model } : {}),
      context: {},
    },
  });

  return serializeChatSession(created);
}

/**
 * 列出项目下所有对话会话（按 updatedAt 倒序）
 *
 * @param projectId 项目 ID
 * @returns 会话数组
 */
export async function listChatSessions(projectId: string): Promise<ChatSession[]> {
  const prisma = getPrismaClient();
  const sessions = await prisma.chatSession.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
  });
  return sessions.map(serializeChatSession);
}

/**
 * 获取会话消息列表（按 createdAt 升序）
 *
 * @param sessionId 会话 ID
 * @returns 消息数组
 */
export async function getChatMessages(sessionId: string): Promise<ChatMessage[]> {
  const prisma = getPrismaClient();
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  return messages.map(serializeChatMessage);
}

/**
 * 发送用户消息
 *
 * 1. 校验会话存在
 * 2. 持久化用户消息（role=user）
 * 3. 返回 ackId（UUID），渲染层用 ackId 关联流式响应事件
 *
 * 实际 AI 调用由 Phase 5b agent.service 异步编排，
 * 通过 stream-bridge 推送 chat:stream:chunk 事件
 *
 * @param input 发送消息入参（sessionId / content）
 * @throws AppError(NOT_FOUND) 会话不存在
 */
export async function sendChatMessage(input: ChatSendMessageInput): Promise<{ ackId: string }> {
  const prisma = getPrismaClient();

  // 校验会话存在
  const session = await prisma.chatSession.findUnique({
    where: { id: input.sessionId },
  });
  if (session === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `对话会话不存在：${input.sessionId}`);
  }

  // 持久化用户消息（tokens 用 content.length 估算，实际 Token 计数由 Phase 5b 完成）
  await prisma.chatMessage.create({
    data: {
      sessionId: input.sessionId,
      role: ChatRole.USER,
      content: input.content,
      tokens: input.content.length,
      metadata: {},
    },
  });

  // 生成 ackId（UUID v4），渲染层用此 ID 关联流式响应事件
  const ackId = randomUUID();
  logger.info({ sessionId: input.sessionId, ackId }, '用户消息已持久化，等待 AI 响应');
  return { ackId };
}

/**
 * 停止 AI 生成
 *
 * 通过 StreamBridge 单例检查并中断 sessionId 对应的活跃流：
 * - 有活跃流：调用 abort()，返回 { stopped: true }
 * - 无活跃流：返回 { stopped: false }
 *
 * @param sessionId 会话 ID（即 StreamBridge 的流 ID）
 */
export async function stopChatGeneration(sessionId: string): Promise<{ stopped: boolean }> {
  const bridge = getStreamBridge();
  if (!(await bridge.has(sessionId))) {
    return { stopped: false };
  }

  await bridge.abort(sessionId);
  logger.info({ sessionId }, '已请求中断 AI 生成');
  return { stopped: true };
}

/**
 * 删除对话会话
 *
 * 流程：
 * 1. 校验会话存在（不存在抛 NOT_FOUND）
 * 2. 若该会话有活跃 AI 流，先 abort（避免删除后流仍尝试写消息造成写入异常）
 * 3. 删除会话（Prisma schema 中 ChatMessage.onDelete: Cascade 会自动级联删除所有消息）
 *
 * @param id 会话 ID
 * @returns `{ id }` 用于渲染层确认删除对象
 * @throws AppError(NOT_FOUND) 会话不存在
 */
export async function deleteChatSession(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  // 1. 校验会话存在
  const session = await prisma.chatSession.findUnique({ where: { id } });
  if (session === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `对话会话不存在：${id}`);
  }

  // 2. 中断可能的活跃 AI 流（避免删除后流仍在尝试持久化 assistant 消息）
  const bridge = getStreamBridge();
  if (await bridge.has(id)) {
    await bridge.abort(id);
    logger.info({ sessionId: id }, '删除会话前已中断活跃 AI 流');
  }

  // 3. 删除会话（消息表 ChatMessage.sessionId onDelete: Cascade 自动级联清理）
  await prisma.chatSession.delete({ where: { id } });

  logger.info({ sessionId: id }, '删除对话会话（含消息级联）');
  return { id };
}

/**
 * 持久化 assistant 消息
 *
 * 供 agent.service 在流式响应结束后调用。
 * tokens 用 content.length 估算（中文按字符计，与 sendChatMessage 一致）。
 *
 * @param sessionId 会话 ID
 * @param content AI 完整回复文本
 * @returns 持久化后的消息
 */
export async function saveAssistantMessage(
  sessionId: string,
  content: string,
): Promise<ChatMessage> {
  const prisma = getPrismaClient();

  const created = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: ChatRole.ASSISTANT,
      content,
      tokens: content.length,
      metadata: {},
    },
  });

  logger.info({ sessionId, length: content.length }, 'assistant 消息已持久化');
  return serializeChatMessage(created);
}

/**
 * 序列化 Prisma ChatSession 记录为 IPC 兼容的 ChatSession 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（model 可空）
 */
function serializeChatSession(raw: RawChatSession): ChatSession {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    context: raw.context as Record<string, unknown>,
    model: raw.model,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/**
 * 序列化 Prisma ChatMessage 记录为 IPC 兼容的 ChatMessage 类型
 *
 * - Date 字段转 ISO 字符串
 * - role 转为 ChatMessage['role']（与 shared ChatRole 字面量一致）
 */
function serializeChatMessage(raw: RawChatMessage): ChatMessage {
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    role: raw.role as ChatMessage['role'],
    content: raw.content,
    tokens: raw.tokens,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
  };
}

/**
 * Prisma chatSession.findUnique 返回的原始类型
 *
 * 使用 NonNullable<> 排除 null，便于在 serializeChatSession 中直接访问字段
 */
type RawChatSession = NonNullable<Awaited<ReturnType<PrismaClient['chatSession']['findUnique']>>>;

/**
 * Prisma chatMessage.findUnique 返回的原始类型
 *
 * 使用 NonNullable<> 排除 null，便于在 serializeChatMessage 中直接访问字段
 */
type RawChatMessage = NonNullable<Awaited<ReturnType<PrismaClient['chatMessage']['findUnique']>>>;
