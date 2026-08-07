// packages/shared/src/schemas/chat.ts
// 聊天域 zod schema 单一真源（P0-3 改造 + P1-6 透传设计）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 chat 域所有 zod schema，作为运行时校验的单一真源
// - 类型（ChatMessage / ChatSendReq / ChatStopReq）从 schema 派生（z.infer）
// - 供 IPC handler 校验入参，避免 handler 内联 schema 重复定义
//
// P1-6 透传设计：
// - 渲染层使用 AI SDK 的 convertToModelMessages 把 UIMessage[] 转为 ModelMessage[]
// - IPC 透传 ModelMessage[]，主进程直接传给 streamText（无需手动转换）
// - 支持 tool-call / reasoning / file 等丰富消息类型（Code Agent 必需）
// - shared 包仅引入 ai 的类型（type-only import，运行时零依赖）
//
// 设计：
// - shared 包已依赖 zod（dependencies），无新增运行时依赖
// - ai 包仅作为 devDependency 引入（类型解析，编译后擦除）
// - ModelMessageSchema 做基本形状校验（role 必填），具体内容由 AI SDK 校验
// - transform 仅在入参 schema 上使用（output 类型兼容 exactOptionalPropertyTypes）
// ──────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai';
import { z } from 'zod';

import { ThinkingLevelSchema } from './thinking';

/**
 * 聊天消息 zod schema（P1-6 透传设计）
 *
 * 透传策略：
 * - 用 z.custom<ModelMessage> 把 z.infer 直接断言为 ModelMessage
 *   （ModelMessage 是 AI SDK 的联合类型，含 user/assistant/system/tool 四种角色及多模态 content）
 * - 运行时只做基本形状校验（对象 + role 字符串 + content 存在），
 *   具体字段结构由 AI SDK 在 streamText 调用时自行校验
 * - 不用 z.object + passthrough：因为后者推断的 z.infer 是 `{role, content, ...}` 对象类型，
 *   不等于 ModelMessage（联合类型），会导致 ChatSendReq.messages 类型与 streamText 入参不兼容
 *
 * 渲染层通过 convertToModelMessages 把 UIMessage[] 转为 ModelMessage[] 后透传，
 * 主进程直接传给 streamText，无需手动转换。
 *
 * @see https://github.com/colinhacks/zod#custom-types
 */
export const ChatMessageSchema: z.ZodType<ModelMessage> = z.custom<ModelMessage>(
  (val): val is ModelMessage => {
    // 基本形状校验：必须是对象，且包含 role（字符串）和 content 字段
    if (typeof val !== 'object' || val === null) {
      return false;
    }
    const obj = val as Record<string, unknown>;
    // noPropertyAccessFromIndexSignature: 用 ['role'] 访问索引签名
    return typeof obj['role'] === 'string' && 'content' in obj;
  },
);

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
  // 思考强度（可选：渲染层设置项，覆盖模型级默认 reasoningEffort）
  thinking: ThinkingLevelSchema.optional().transform((v) => v ?? undefined),
});

/** chat:send 响应 zod schema（响应契约校验用） */
export const ChatSendResSchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * chat:stop 入参 zod schema
 */
export const ChatStopReqSchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * 聊天消息类型（P1-6 透传设计）
 *
 * 直接使用 AI SDK 的 ModelMessage 类型，支持：
 * - user / assistant / system / tool 四种角色
 * - content 为 string 或结构化数组（多模态、tool-call 等）
 *
 * 渲染层通过 convertToModelMessages 转换后直接透传，
 * 主进程直接传给 streamText，无需手动转换或类型断言。
 *
 * 注意：类型直接引用 AI SDK（type-only import，运行时零依赖），
 * 运行时校验由 ChatMessageSchema 负责（宽松校验 role + content）。
 */
export type ChatMessage = ModelMessage;
