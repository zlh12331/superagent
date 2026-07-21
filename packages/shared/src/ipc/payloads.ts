// packages/shared/src/ipc/payloads.ts
// IPC 请求/响应/事件 payload 类型映射
// 设计文档 §5.3 完整 Channel 清单
//
// 每个请求-响应 channel 定义 Req（请求入参）和 Res（响应数据）类型
// 流式/事件 channel 定义 Payload 类型
//
// 说明：
// - 业务相关 payload（project/chapter/character/worldview/rag/agent/settings）
//   已随数据库层一并删除
// - 当前保留应用级 payload + chat 域 payload（基于 Vercel AI SDK v7）
//   chat 域采用 UIMessageStreamPart 作为流式 part 类型，与官方协议保持一致
//
// P0-3 改造：
// - chat 域类型从 zod schema 派生（z.infer），schema 作为单一真源
// - 避免类型与 schema 双向漂移
// - schema 文件：../schemas/chat.ts

import type { z } from 'zod';
import type { ChatMessageSchema, ChatSendReqSchema, ChatStopReqSchema } from '../schemas/chat';

/**
 * 应用状态（health check）
 *
 * 说明：原 PG/Ollama/DB 状态字段已随数据库层删除，
 * 当前仅保留应用运行状态标记，便于渲染层做基本健康检查。
 */
export interface AppStatus {
  /** 应用是否已就绪（true 表示主进程初始化完成） */
  readonly ready: boolean;
}

/**
 * 聊天消息（Vercel AI SDK CoreMessage 子集）
 *
 * 类型从 ChatMessageSchema 派生（z.infer），schema 为单一真源。
 *
 * 限制为 user/assistant/system 三种角色，与 DeepSeek API 兼容。
 * 渲染层调用 IPC 时把 useChat 的 UIMessage 转换为此结构传给主进程。
 */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * chat:send 请求 payload
 *
 * 类型从 ChatSendReqSchema 派生（z.infer），schema 为单一真源。
 *
 * 消息列表由渲染层维护，每次发起对话把完整历史传给主进程，
 * 主进程不持有对话上下文（无状态设计，便于多窗口/多会话扩展）。
 *
 * sessionId 使用 `string | undefined` 而非 `?: string`：
 * exactOptionalPropertyTypes 严格模式下，zod `.optional().transform()` 推断为 `string | undefined`，
 * 显式声明 `| undefined` 才能兼容 zod schema 推断的类型。
 */
export type ChatSendReq = z.infer<typeof ChatSendReqSchema>;

/**
 * chat:send 响应 payload：返回本次对话的 sessionId
 */
export interface ChatSendRes {
  /** 本次对话的唯一标识，渲染层用此 id 订阅后续流式事件并支持中断 */
  readonly sessionId: string;
}

/**
 * chat:stop 请求 payload：中断指定 sessionId 的对话
 *
 * 类型从 ChatStopReqSchema 派生（z.infer），schema 为单一真源。
 */
export type ChatStopReq = z.infer<typeof ChatStopReqSchema>;

/** chat:stop 响应 payload */
export interface ChatStopRes {
  /** 是否成功中断（若对话已结束则返回 false） */
  readonly stopped: boolean;
}

/**
 * chat:stream:part 事件 payload
 *
 * part 类型为 Vercel AI SDK 官方 UIMessageStreamPart 的 JSON 序列化形式。
 * 通过 IPC 传输时使用 unknown 而非具体类型，避免 shared 包依赖 ai 包
 * （shared 包应保持零运行时依赖，仅暴露类型契约）。
 *
 * 渲染层在 IpcChatTransport 中把 unknown 重新喂给 useChat 的 ReadableStream。
 */
export interface ChatStreamPartPayload {
  /** 本次对话的 sessionId，渲染层按 id 过滤事件 */
  readonly sessionId: string;
  /**
   * UIMessageStreamPart 的 JSON 序列化对象。
   * 主进程从 toUIMessageStream() 读出后原样转发，渲染层直接 enqueue。
   */
  readonly part: unknown;
}

/** chat:stream:end 事件 payload：流正常结束 */
export interface ChatStreamEndPayload {
  /** 本次对话的 sessionId */
  readonly sessionId: string;
}

/** chat:stream:error 事件 payload：流异常结束 */
export interface ChatStreamErrorPayload {
  /** 本次对话的 sessionId */
  readonly sessionId: string;
  /** 错误码（与 AppError.code 对齐） */
  readonly code: string;
  /** 错误消息（人类可读，用于渲染层 toast） */
  readonly message: string;
}

/** 请求-响应 channel 类型映射：Req → Res */
export interface IpcRequestMap {
  // 应用级
  'app:getStatus': { req: void; res: AppStatus };
  'app:openExternal': { req: { url: string }; res: { ok: boolean } };

  // 聊天域（Vercel AI SDK v7）
  'chat:send': { req: ChatSendReq; res: ChatSendRes };
  'chat:stop': { req: ChatStopReq; res: ChatStopRes };
}

/**
 * 流式/事件 channel payload 映射
 *
 * chat 域流式事件由主进程主动推送，渲染层通过 ipcRenderer.on 订阅。
 */
export interface IpcEventMap {
  // 聊天流式 part：主进程逐 part 推送 UIMessageStreamPart
  'chat:stream:part': ChatStreamPartPayload;
  // 聊天流式结束：正常完成
  'chat:stream:end': ChatStreamEndPayload;
  // 聊天流式错误：异常终止
  'chat:stream:error': ChatStreamErrorPayload;
}
