// packages/shared/src/schemas/chat.schema.ts
// ChatSession / ChatMessage Zod schema
// 字段来源：设计文档 §6.2 Prisma ChatSession / ChatMessage 模型

import { z } from 'zod';
import { ChatRole } from '../types/enums';

/** ChatSession 实体 schema */
export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  context: z.record(z.string(), z.unknown()).default({}),
  model: z.string().max(50).nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

/** ChatMessage 实体 schema */
export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum([ChatRole.USER, ChatRole.ASSISTANT, ChatRole.SYSTEM]),
  content: z.string(),
  tokens: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 创建会话入参 */
export const ChatSessionCreateInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  model: z.string().max(50).optional(),
});
export type ChatSessionCreateInput = z.infer<typeof ChatSessionCreateInputSchema>;

/** 发送消息入参 */
export const ChatSendMessageInputSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
});
export type ChatSendMessageInput = z.infer<typeof ChatSendMessageInputSchema>;

/** 流式 chunk 事件 payload */
export const ChatStreamChunkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  chunk: z.string(),
});
export type ChatStreamChunkPayload = z.infer<typeof ChatStreamChunkPayloadSchema>;

/** 流式 end 事件 payload */
export const ChatStreamEndPayloadSchema = z.object({
  sessionId: z.string().min(1),
  fullText: z.string(),
});
export type ChatStreamEndPayload = z.infer<typeof ChatStreamEndPayloadSchema>;

/** 流式 error 事件 payload */
export const ChatStreamErrorPayloadSchema = z.object({
  sessionId: z.string().min(1),
  error: z.unknown(),
});
export type ChatStreamErrorPayload = z.infer<typeof ChatStreamErrorPayloadSchema>;
