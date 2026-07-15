/**
 * ServerNotification 类型和映射层
 *
 * 后端通过 `codex:notification` Tauri 事件推送 ServerNotification。
 * 后端序列化格式为 `{ method: string, params: {...} }`（serde tag-content 模式）。
 *
 * 本文件定义前端需要的最小通知类型和解析函数，
 * 将后端 payload 映射为 streaming-store 可消费的 StreamingChunk。
 *
 * @see src-tauri/codex-rs/app-server-protocol/src/protocol/common.rs — 后端枚举定义
 * @see src-tauri/codex-rs/desktop/src/bridge/event.rs — Tauri emit 代码
 * @see src/store/streaming-store.ts — 流式缓冲区 store
 */

import type { StreamingChunk, StreamingDeltaType } from './types'

// ─── 通知方法名常量 ─────────────────────────────────────────────

/**
 * 后端 ServerNotification 的 method 字段值
 *
 * 对应后端 `server_notification_definitions!` 宏中的 wire 名称。
 * 这里只列出流式消息相关的方法，其他方法在 ConversationArea 中统一走 invalidate 路径。
 */
export const NotificationMethod = {
  /** 轮次开始 — 触发 startStreaming */
  TURN_STARTED: 'turn/started',
  /** 轮次完成 — 触发 stopStreaming + invalidate */
  TURN_COMPLETED: 'turn/completed',
  /** 条目开始 — 后端开始生成一个新的消息条目 */
  ITEM_STARTED: 'item/started',
  /** 条目完成 — 触发 stopStreaming + invalidate */
  ITEM_COMPLETED: 'item/completed',
  /** 文本增量 — 核心 delta，触发 appendDelta */
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  /** 推理摘要增量 — 触发 appendDelta */
  REASONING_SUMMARY_DELTA: 'item/reasoning/summaryTextDelta',
  /** 原始推理增量 — 触发 appendDelta */
  REASONING_TEXT_DELTA: 'item/reasoning/textDelta',
  /** 计划增量 — 触发 appendDelta */
  PLAN_DELTA: 'item/plan/delta',
} as const

// ─── 通知 payload 类型 ─────────────────────────────────────────

/**
 * 后端通知的最小通用字段
 *
 * 所有 delta 和 lifecycle 通知都包含 threadId 和 turnId。
 */
interface BaseNotificationParams {
  threadId: string
  turnId: string
}

/** 文本增量通知 payload */
interface AgentMessageDeltaParams extends BaseNotificationParams {
  itemId: string
  delta: string
}

/** 推理增量通知 payload（summaryTextDelta 和 textDelta 共用此结构） */
interface ReasoningDeltaParams extends BaseNotificationParams {
  itemId: string
  delta: string
  /** summary 索引（仅 summaryTextDelta 有） */
  summaryIndex?: number
  /** content 索引（仅 textDelta 有） */
  contentIndex?: number
}

/** 计划增量通知 payload */
interface PlanDeltaParams extends BaseNotificationParams {
  itemId: string
  delta: string
}

/** 条目生命周期通知 payload（started/completed 共用） */
interface ItemLifecycleParams extends BaseNotificationParams {
  /** 后端 ThreadItem 的序列化对象（前端目前不解析具体结构） */
  item: unknown
  /** Unix 时间戳（毫秒） */
  startedAtMs?: number
  completedAtMs?: number
}

/** 轮次生命周期通知 payload */
interface TurnLifecycleParams extends BaseNotificationParams {
  /** 后端 Turn 对象的序列化（前端目前不解析具体结构） */
  turn?: unknown
  startedAtMs?: number
  completedAtMs?: number
}

// ─── 判别式联合类型 ─────────────────────────────────────────────

/**
 * 后端 ServerNotification 的判别式联合
 *
 * 通过 `method` 字段区分变体，`params` 为对应 payload。
 * 仅包含流式消息相关的通知类型，其他类型通过 fallback 处理。
 */
export type ServerNotification =
  | { method: typeof NotificationMethod.TURN_STARTED; params: TurnLifecycleParams }
  | { method: typeof NotificationMethod.TURN_COMPLETED; params: TurnLifecycleParams }
  | { method: typeof NotificationMethod.ITEM_STARTED; params: ItemLifecycleParams }
  | { method: typeof NotificationMethod.ITEM_COMPLETED; params: ItemLifecycleParams }
  | { method: typeof NotificationMethod.AGENT_MESSAGE_DELTA; params: AgentMessageDeltaParams }
  | { method: typeof NotificationMethod.REASONING_SUMMARY_DELTA; params: ReasoningDeltaParams }
  | { method: typeof NotificationMethod.REASONING_TEXT_DELTA; params: ReasoningDeltaParams }
  | { method: typeof NotificationMethod.PLAN_DELTA; params: PlanDeltaParams }
  | { method: string; params: Record<string, unknown> } // fallback：未知通知

// ─── 解析函数 ──────────────────────────────────────────────────

/**
 * 从 Tauri 事件的未知 payload 解析为 ServerNotification
 *
 * 后端序列化格式为 `{ method: string, params: {...} }`。
 * 本函数做最小验证后直接 cast，不做深度校验（后端保证类型正确）。
 *
 * @param payload — Tauri 事件的 e.payload
 * @returns 解析后的 ServerNotification
 */
export function parseNotification(
  payload: unknown
): ServerNotification {
  // 后端 serde 保证 payload 是 { method, params } 结构
  // 这里只做最小验证，不做深度校验
  const raw = payload as { method?: string; params?: unknown }
  const method = raw.method ?? 'unknown'
  const params = (raw.params ?? {}) as Record<string, unknown>
  return { method, params } as ServerNotification
}

// ─── 映射函数 ──────────────────────────────────────────────────

/**
 * 从通知中提取 threadId
 *
 * 所有流式相关通知的 params 都包含 threadId。
 * 未知通知尝试从 params 中读取。
 *
 * @param notif — 解析后的通知
 * @returns threadId 或 null
 */
export function getNotificationThreadId(
  notif: ServerNotification
): string | null {
  const params = notif.params as BaseNotificationParams | Record<string, unknown>
  if ('threadId' in params && typeof params.threadId === 'string') {
    return params.threadId
  }
  return null
}

/**
 * 将 delta 类型的通知映射为 streaming-store 可消费的 StreamingChunk
 *
 * 仅处理 delta 类型的通知（AGENT_MESSAGE_DELTA / REASONING_*_DELTA / PLAN_DELTA）。
 * 其他类型返回 null，由调用方走其他路径。
 *
 * @param notif — 解析后的通知
 * @returns StreamingChunk 或 null（非 delta 类型）
 */
export function notificationToStreamingChunk(
  notif: ServerNotification
): StreamingChunk | null {
  const params = notif.params as
    | AgentMessageDeltaParams
    | ReasoningDeltaParams
    | PlanDeltaParams

  const timestamp = Date.now()

  switch (notif.method) {
    case NotificationMethod.AGENT_MESSAGE_DELTA:
      return {
        itemId: params.itemId,
        type: 'text' as StreamingDeltaType,
        delta: params.delta,
        timestamp,
      }

    case NotificationMethod.REASONING_SUMMARY_DELTA:
    case NotificationMethod.REASONING_TEXT_DELTA:
      return {
        itemId: params.itemId,
        type: 'reasoning_delta' as StreamingDeltaType,
        delta: params.delta,
        timestamp,
      }

    case NotificationMethod.PLAN_DELTA:
      // 后端 PlanDelta 推送增量文本，前端 plan_delta 类型逐字累积到 planText 字段，
      // 完成时由 parsePlanText 解析为 PlanItem[]（在 streaming-store.buildMessageFromItem 中处理）。
      return {
        itemId: params.itemId,
        type: 'plan_delta' as StreamingDeltaType,
        delta: params.delta,
        timestamp,
      }

    default:
      // 非 delta 类型通知
      return null
  }
}

/**
 * 判断通知是否是流式 delta 类型
 *
 * 用于 ConversationArea 事件分流：delta 类型走 streaming-store，其他走 invalidate。
 */
export function isDeltaNotification(notif: ServerNotification): boolean {
  return notificationToStreamingChunk(notif) !== null
}

/**
 * 判断通知是否是轮次/条目生命周期完成事件
 *
 * 完成事件需要 stopStreaming + invalidate，保证最终一致性。
 */
export function isCompletionNotification(notif: ServerNotification): boolean {
  return (
    notif.method === NotificationMethod.TURN_COMPLETED ||
    notif.method === NotificationMethod.ITEM_COMPLETED
  )
}

/**
 * 判断通知是否是单个条目完成事件
 *
 * item/completed 触发逐 item 归档管道：
 * resolveStreamingItem → setQueryData（乐观更新）→ invalidate（后台刷新）
 */
export function isItemCompletedNotification(
  notif: ServerNotification
): boolean {
  return notif.method === NotificationMethod.ITEM_COMPLETED
}

/**
 * 判断通知是否是条目开始事件
 *
 * item/started 表示后端开始生成新条目，无需触发全量刷新
 * （流式 delta 会增量更新 streaming-store）。
 */
export function isItemStartedNotification(
  notif: ServerNotification
): boolean {
  return notif.method === NotificationMethod.ITEM_STARTED
}

/**
 * 从 item/started 或 item/completed 通知中提取 itemId
 *
 * 后端 ItemLifecycleParams.item 是 ThreadItem 的序列化对象，
 * 所有 ThreadItem 变体都包含 id 字段（见 item.rs）。
 * 本函数做最小验证后提取 id。
 *
 * @param notif — item/started 或 item/completed 通知
 * @returns itemId 或 null（无法提取时）
 */
export function getItemIdFromLifecycleNotification(
  notif: ServerNotification
): string | null {
  const params = notif.params as ItemLifecycleParams
  const item = params.item as { id?: unknown } | null
  if (item && typeof item.id === 'string') {
    return item.id
  }
  return null
}

/**
 * 判断通知是否是轮次开始事件
 *
 * 开始事件需要 startStreaming，进入流式模式。
 */
export function isTurnStartNotification(notif: ServerNotification): boolean {
  return notif.method === NotificationMethod.TURN_STARTED
}
