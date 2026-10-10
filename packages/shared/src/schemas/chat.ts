// chat.ts：聊天消息的跨进程契约——AI SDK ModelMessage 的透传校验（ChatMessageSchema）与类型别名（ChatMessage）
// 边界：不做字段级结构校验（交 AI SDK 在调用时校验）；agent:run 与会话历史的 messages 均复用本契约。

import type { ModelMessage } from 'ai';
import { z } from 'zod';

/**
 * 聊天消息 zod schema：把 AI SDK 的 ModelMessage 透传成 IPC 可校验的 zod schema
 *
 * 透传策略：
 * - 用 z.custom<ModelMessage> + z.ZodType<ModelMessage> 标注，使 z.infer 即为 ModelMessage
 *   （user/assistant/system/tool 四角色联合，content 覆盖多模态与 tool-call 结构）
 * - 运行时只做基本形状校验（对象 + role 字符串 + content 存在），字段结构由 AI SDK
 *   在 streamText 调用时自行校验（不匹配抛 InvalidPromptError）
 * - 不用 z.object + passthrough：它推不出 ModelMessage 联合——role 只落成 string 类型，
 *   赋值给 ModelMessage 报 TS2322，messages 传不进 streamText
 *
 * 渲染层用 convertToModelMessages 把 UIMessage[] 转成 ModelMessage[] 后经 agent:run 透传，
 * 主进程原样交给 streamText，无需再转换或断言。
 *
 * @see https://zod.dev/api#custom
 */
export const ChatMessageSchema: z.ZodType<ModelMessage> = z.custom<ModelMessage>(
  (val): val is ModelMessage => {
    if (typeof val !== 'object' || val === null) {
      return false;
    }
    const obj = val as Record<string, unknown>;
    // 索引签名取值必须用 ['role']（noPropertyAccessFromIndexSignature 禁点访问）
    return typeof obj['role'] === 'string' && 'content' in obj;
  },
);

/**
 * 聊天消息类型：直接取 AI SDK 的 ModelMessage，供消费方零转换引用
 *
 * 即 ChatMessageSchema 的静态类型（z.infer 推导结果与之一致）；
 * 支持 user / assistant / system / tool 四角色，content 为 string 或结构化数组（多模态、tool-call 等）。
 * 运行时校验仍以 ChatMessageSchema 为准（宽松校验 role + content）；
 * 本符号 type-only 引用 AI SDK（编译后擦除，运行时零依赖）。
 */
export type ChatMessage = ModelMessage;
