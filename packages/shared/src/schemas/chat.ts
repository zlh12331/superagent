// packages/shared/src/schemas/chat.ts
// 聊天域 zod schema 单一真源（P0-3 改造）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 chat 域所有 zod schema，作为类型与运行时校验的单一真源
// - 类型（ChatMessage / ChatSendReq / ChatStopReq）从 schema 派生（z.infer）
// - 供 IPC handler 校验入参，避免 handler 内联 schema 重复定义
//
// 设计：
// - shared 包已依赖 zod（dependencies），无新增依赖
// - schema 与类型一一对应，类型不再手动维护（消除双向漂移风险）
// - transform 仅在入参 schema 上使用（output 类型兼容 exactOptionalPropertyTypes）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * 聊天消息 zod schema
 *
 * 与 Vercel AI SDK CoreMessage 子集对齐：
 * - role：user / assistant / system（与 DeepSeek API 兼容）
 * - content：纯文本字符串（多模态暂不支持）
 *
 * 渲染层调用 IPC 时把 useChat 的 UIMessage 转换为此结构传给主进程。
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
});

/**
 * chat:send 入参 zod schema
 *
 * sessionId 用 `.optional().transform(v => v ?? undefined)`：
 * - 运行时允许字段缺失（渲染层首次发起对话时不传 sessionId）
 * - transform 把缺失值统一转为 undefined，让 output 类型为 `string | undefined`
 *   （必填字段，值可为 undefined，兼容 exactOptionalPropertyTypes）
 *
 * 这样与 ChatSendReq.sessionId: `string | undefined` 类型完全对齐。
 */
export const ChatSendReqSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  sessionId: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/**
 * chat:stop 入参 zod schema
 */
export const ChatStopReqSchema = z.object({
  sessionId: z.string().min(1),
});
