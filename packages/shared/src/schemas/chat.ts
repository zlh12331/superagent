import type { ModelMessage } from 'ai';
import { z } from 'zod';

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
    if (typeof val !== 'object' || val === null) {
      return false;
    }
    const obj = val as Record<string, unknown>;
    return typeof obj['role'] === 'string' && 'content' in obj;
  },
);

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
