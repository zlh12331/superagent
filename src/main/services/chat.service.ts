// src/main/services/chat.service.ts
// AI 对话业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ChatSession / ChatMessage 模型
//
// 职责：
// 1. 对话会话管理（createSession / listSessions）
// 2. 消息管理（getMessages / sendMessage）
// 3. sendChatMessage 持久化用户消息并返回 ackId（实际 AI 调用由 Phase 5b agent.service 编排）
// 4. stopChatGeneration：Phase 5a 占位（5b 实现 AbortController 管理）
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
 * Phase 5a 占位实现：返回 stopped=false（无活跃生成）
 * Phase 5b 将通过 AbortController 管理实际停止逻辑
 *
 * @param _sessionId 会话 ID（Phase 5a 暂未使用）
 */
export async function stopChatGeneration(_sessionId: string): Promise<{ stopped: boolean }> {
  // Phase 5a 占位：无实际生成可停止
  // Phase 5b 实现：检查 sessionId 对应的 AbortController，调用 abort()
  return { stopped: false };
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
