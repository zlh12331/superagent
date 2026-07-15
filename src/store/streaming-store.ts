/**
 * Streaming Store — Zustand
 *
 * 管理流式消息的增量 delta 追加。
 * 按 itemId 路由 StreamingChunk 到对应的 StreamingItem 缓冲区，
 * 流式完成后通过 resolveStreamingItem 转为最终 Message，
 * 由 ConversationArea 归档到 TanStack Query 缓存（乐观更新），
 * 再由 invalidateMessages 触发后台刷新保证最终一致性。
 *
 * 设计要点：
 * - streamingItems 按 itemId 索引，每个 item 独立累积增量
 * - appendDelta 根据 chunk.type 路由到对应字段（文本 / 推理 / 工具调用 / 文件变更 / 计划等）
 * - plan_delta 类型累积文本到 planText，完成时由 parsePlanText 解析为 PlanItem[]
 * - buildMessageFromItem 将 StreamingItem 转为完整 Message（含结构化内容），供归档和预览复用
 * - 使用手动不可变更新（项目未引入 immer），确保引用变更最小化
 * - get() 模式：回调中读取最新值用 get() 而非订阅
 *
 * @see src/lib/codex/types.ts — StreamingChunk / Message 等类型定义
 * @see src/features/conversation/ConversationArea.tsx — 归档管道调用方
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  StreamingChunk,
  Message,
  MessageContentType,
  ToolCall,
  FileChange,
  PlanItem,
  InlineApprovalCard,
} from '@/lib/codex/types'
import { logger } from '@/lib/logger'

// ─── 流式条目类型 ──────────────────────────────────────────────

/**
 * 流式消息缓冲区中的单个条目
 *
 * 按 itemId 索引，累积流式增量 delta 的结构化内容。
 * 一个 StreamingItem 对应一条正在流式输出的消息，
 * 可能包含文本、推理、工具调用、文件变更等多种内容。
 */
export interface StreamingItem {
  /** 关联的 item ID（与后端事件路由对应） */
  itemId: string
  /** 关联的 thread ID（用于按会话清除缓冲） */
  threadId: string
  /** 累积的文本内容（text 类型 delta 逐字追加） */
  text: string
  /** 累积的推理内容（reasoning_delta 逐字追加） */
  reasoning?: string
  /** 工具调用列表（按 tool_call_start 到达顺序累积） */
  toolCalls: ToolCall[]
  /** 文件变更列表（file_change 类型 delta 追加） */
  fileChanges: FileChange[]
  /** 执行计划项列表（plan_update 类型 delta 更新） */
  planItems?: PlanItem[]
  /**
   * 计划增量文本累积（plan_delta 类型 delta 逐字追加）。
   *
   * 后端 item/plan/delta 推送的是增量文本（PlanDelta.text），
   * 与 plan_update（完整 PlanItem[] 列表）数据形态不同。
   * 流式过程中累积到 planText，完成时由 parsePlanText 解析为 PlanItem[]。
   */
  planText?: string
  /** 内联审批卡片（approval_request 类型 delta 设置） */
  approval?: InlineApprovalCard
  /** 是否正在流式输出（done 类型 delta 标记为 false） */
  isStreaming: boolean
  /** 错误信息（error 类型 delta 设置） */
  error?: string
  /** 条目创建时间戳（用于流式消息的 timestamp 字段，避免渲染期间调用 Date.now()） */
  startedAt: number
}

/**
 * 流式消息 Store 的状态接口
 */
export interface StreamingState {
  /** 按 itemId 索引的流式消息缓冲区 */
  streamingItems: Record<string, StreamingItem>
  /** 当前活跃的流式 turn 的 threadId */
  activeStreamingThread: string | null
  /** 是否正在流式输出 */
  isStreaming: boolean

  // ─── Actions ────────────────────────────────────────────────

  /** 开始流式输出，设置活跃 thread 和 isStreaming 标志 */
  startStreaming: (threadId: string) => void
  /** 根据增量块类型路由 delta 到对应的 StreamingItem */
  appendDelta: (chunk: StreamingChunk) => void
  /** 停止流式输出，清理 isStreaming 标志 */
  stopStreaming: (threadId: string) => void
  /** 清除指定 thread 的所有流式缓冲 */
  clearStreaming: (threadId: string) => void
  /** 获取指定 itemId 的流式内容（非响应式读取，用 get() 模式） */
  getStreamingItem: (itemId: string) => StreamingItem | undefined
  /** 将流式内容转为最终 Message 对象并从缓冲区移除 */
  resolveStreamingItem: (itemId: string) => Message | undefined
}

// ─── 私有辅助函数 ──────────────────────────────────────────────

/**
 * 将流式增量块应用到 StreamingItem，返回新的 item（不可变更新）。
 *
 * 根据 chunk.type 路由到对应字段：
 * - text / reasoning_delta：追加文本
 * - tool_call_start / tool_call_end：管理工具调用列表
 * - file_change / plan_update / approval_request / error / done：更新对应结构化字段
 *
 * @param item - 当前流式条目（不会被修改，返回新对象）
 * @param chunk - 流式增量块
 * @returns 更新后的新流式条目
 */
function applyDeltaToItem(
  item: StreamingItem,
  chunk: StreamingChunk
): StreamingItem {
  switch (chunk.type) {
    // 文本增量：追加到 item.text
    case 'text':
      return { ...item, text: item.text + (chunk.delta ?? '') }

    // 推理内容增量：追加到 item.reasoning
    case 'reasoning_delta':
      return {
        ...item,
        reasoning: (item.reasoning ?? '') + (chunk.delta ?? ''),
      }

    // 工具调用开始：新增 ToolCall 到列表末尾
    case 'tool_call_start': {
      const newCall = chunk.toolCall
      if (!newCall) return item
      return { ...item, toolCalls: [...item.toolCalls, newCall] }
    }

    // 工具调用参数增量：当前 ToolCall 类型未提供原始参数缓冲字段，
    // 待后端协议确定后可在此扩展。此处保持条目不变。
    case 'tool_call_delta':
      return item

    // 工具调用结束：按 ID 匹配并更新对应 ToolCall 的 status / result / error / durationMs
    case 'tool_call_end': {
      const endedCall = chunk.toolCall
      if (!endedCall) return item
      const idx = item.toolCalls.findIndex(tc => tc.id === endedCall.id)
      if (idx === -1) return item
      const existing = item.toolCalls[idx]
      if (!existing) return item
      // 仅更新结束阶段提供的字段（exactOptionalPropertyTypes 要求不赋 undefined）
      const updated: ToolCall = { ...existing, status: endedCall.status }
      if (endedCall.result !== undefined) {
        updated.result = endedCall.result
      }
      if (endedCall.error !== undefined) {
        updated.error = endedCall.error
      }
      if (endedCall.durationMs !== undefined) {
        updated.durationMs = endedCall.durationMs
      }
      // 仅替换目标元素，其余保持原引用（最小化引用变更）
      const toolCalls = [...item.toolCalls]
      toolCalls[idx] = updated
      return { ...item, toolCalls }
    }

    // 文件变更：追加到 item.fileChanges
    case 'file_change': {
      const change = chunk.fileChange
      if (!change) return item
      return { ...item, fileChanges: [...item.fileChanges, change] }
    }

    // 计划更新：整体替换 item.planItems
    case 'plan_update': {
      const planItems = chunk.planItems
      if (!planItems) return item
      return { ...item, planItems }
    }

    // 计划增量文本：逐字追加到 item.planText
    // 后端 item/plan/delta 推送增量文本，完成时由 parsePlanText 解析为 PlanItem[]
    case 'plan_delta':
      return {
        ...item,
        planText: (item.planText ?? '') + (chunk.delta ?? ''),
      }

    // 审批请求：设置 item.approval
    case 'approval_request': {
      const approval = chunk.approval
      if (!approval) return item
      return { ...item, approval }
    }

    // 错误通知：设置 item.error
    case 'error': {
      const error = chunk.error
      if (error === undefined) return item
      return { ...item, error }
    }

    // 流式结束：标记 item.isStreaming = false
    case 'done':
      return { ...item, isStreaming: false }

    // 穷尽性检查：如果未来 StreamingDeltaType 新增类型未处理，此处编译报错
    default: {
      const _exhaustive: never = chunk.type
      throw new Error(`未处理的流式增量类型: ${_exhaustive}`)
    }
  }
}

/**
 * 将累积的 plan 增量文本解析为 PlanItem[] 列表。
 *
 * 后端 item/plan/delta 推送增量文本（PlanDelta.text），
 * 流式过程中累积到 planText，完成时调用本函数解析。
 *
 * 解析规则（按行分割，兼容常见 plan 文本格式）：
 * - 跳过空行
 * - 去除行首空白和常见前缀符号（-、*、•、数字序号如 "1." "1)"）
 * - 每行作为一个 step，状态默认 pending
 *
 * 注意：这是前端解析，后端协议稳定后可改为后端推送完整 PlanItem[]。
 *
 * @param planText - 累积的计划增量文本
 * @returns 解析后的 PlanItem 数组（空文本返回空数组）
 */
function parsePlanText(planText: string): PlanItem[] {
  const lines = planText.split('\n')
  const items: PlanItem[] = []
  let index = 0
  for (const rawLine of lines) {
    // 去除行首尾空白
    const trimmed = rawLine.trim()
    // 跳过空行
    if (!trimmed) continue
    // 去除常见前缀符号（-、*、•、数字序号）
    const cleaned = trimmed
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
    if (!cleaned) continue
    index += 1
    items.push({
      index,
      text: cleaned,
      status: 'pending',
    })
  }
  return items
}

/**
 * 将 StreamingItem 转为最终 Message 对象。
 *
 * 映射规则：
 * - role 固定为 'assistant'（流式消息为助手回复）
 * - content 根据内容优先级判定：有文本则 'text'，否则按 approval > plan > file_change > tool_call
 * - toolCall / fileChange 取列表最后一项（Message 接口为单值字段）
 * - reasoning 字符串包装为 ReasoningBlock 结构
 * - plan 优先使用 planItems（plan_update 类型），其次解析 planText（plan_delta 累积）
 * - error 追加到 text 末尾（Message 接口无 error 字段，用 [error] 前缀标识）
 *
 * @param item - 流式条目
 * @returns 最终 Message 对象
 */
export function buildMessageFromItem(item: StreamingItem): Message {
  // 如果存在错误信息，追加到文本末尾（Message 接口无 error 字段）
  let text = item.text
  if (item.error) {
    text = text ? `${text}\n\n[error] ${item.error}` : `[error] ${item.error}`
  }

  // 解析计划项：优先使用 planItems（plan_update），其次解析 planText（plan_delta 累积）
  const planItems =
    item.planItems && item.planItems.length > 0
      ? item.planItems
      : item.planText
        ? parsePlanText(item.planText)
        : undefined

  // 确定消息内容类型：有文本则 text，否则按结构化内容优先级判定
  let content: MessageContentType = 'text'
  if (!text) {
    if (item.approval) {
      content = 'approval'
    } else if (planItems && planItems.length > 0) {
      content = 'plan'
    } else if (item.fileChanges.length > 0) {
      content = 'file_change'
    } else if (item.toolCalls.length > 0) {
      content = 'tool_call'
    }
  }

  // 构建基础 Message（必填字段）
  const message: Message = {
    id: item.itemId,
    role: 'assistant',
    content,
    text,
    // 使用 item 自带的时间戳，避免在渲染期间调用 Date.now() 产生副作用
    timestamp: item.startedAt,
    isStreaming: false,
    itemId: item.itemId,
  }

  // 条件设置可选字段（exactOptionalPropertyTypes 不允许赋 undefined）
  if (item.reasoning) {
    message.reasoning = {
      id: `reasoning-${item.itemId}`,
      content: item.reasoning,
      durationMs: 0,
      tokenCount: 0,
      isStreaming: false,
    }
  }

  if (item.toolCalls.length > 0) {
    const lastCall = item.toolCalls[item.toolCalls.length - 1]
    if (lastCall) {
      message.toolCall = lastCall
    }
  }

  if (item.fileChanges.length > 0) {
    const lastChange = item.fileChanges[item.fileChanges.length - 1]
    if (lastChange) {
      message.fileChange = lastChange
    }
  }

  if (planItems && planItems.length > 0) {
    message.planItems = planItems
  }

  if (item.approval) {
    message.approval = item.approval
  }

  return message
}

// ─── Store 创建 ────────────────────────────────────────────────

const streamingStoreCreator: StateCreator<
  StreamingState,
  [['zustand/devtools', never]]
> = (set, get) => ({
  streamingItems: {},
  activeStreamingThread: null,
  isStreaming: false,

  /**
   * 开始流式输出
   * 设置活跃 threadId 和 isStreaming 标志，标记进入流式模式。
   */
  startStreaming: (threadId: string) =>
    set(
      { activeStreamingThread: threadId, isStreaming: true },
      undefined,
      'startStreaming'
    ),

  /**
   * 追加流式增量
   * 根据 chunk.itemId 路由到对应的 StreamingItem，
   * 若条目不存在则自动创建（关联当前活跃 threadId）。
   * 内部仅变更目标 item 的引用，其余 item 保持原引用。
   */
  appendDelta: (chunk: StreamingChunk) =>
    set(
      (state: StreamingState) => {
        const existing = state.streamingItems[chunk.itemId]
        // 乱序 delta（startStreaming 之前到达）：丢弃并记录 warning，
        // 避免创建 threadId 为空的孤儿 item（无活跃会话时无法关联到任何线程）
        if (!existing && !state.activeStreamingThread) {
          logger.warn('Delta received before startStreaming, discarding', {
            itemId: chunk.itemId,
          })
          return {}
        }
        // 优先使用已有条目的 threadId，其次用活跃 threadId
        const threadId = existing?.threadId ?? state.activeStreamingThread ?? ''

        // 获取或创建基础条目（新条目需要类型标注以推导空数组的元素类型）
        const baseItem: StreamingItem = existing ?? {
          itemId: chunk.itemId,
          threadId,
          text: '',
          toolCalls: [],
          fileChanges: [],
          isStreaming: true,
          startedAt: Date.now(),
        }

        // 应用增量并更新缓冲区（仅目标 item 引用变更）
        const updated = applyDeltaToItem(baseItem, chunk)
        return {
          streamingItems: {
            ...state.streamingItems,
            [chunk.itemId]: updated,
          },
        }
      },
      undefined,
      'appendDelta'
    ),

  /**
   * 停止流式输出
   * 仅当 threadId 匹配当前活跃会话时执行：
   * - 清除 isStreaming 和 activeStreamingThread
   * - 标记该会话下所有条目为非流式状态（isStreaming = false）
   * 若 threadId 不匹配，返回空 patch 避免不必要的渲染。
   */
  stopStreaming: (threadId: string) =>
    set(
      (state: StreamingState) => {
        if (state.activeStreamingThread !== threadId) {
          return {}
        }
        const nextItems: Record<string, StreamingItem> = {}
        for (const [key, item] of Object.entries(state.streamingItems)) {
          nextItems[key] =
            item.threadId === threadId ? { ...item, isStreaming: false } : item
        }
        return {
          streamingItems: nextItems,
          activeStreamingThread: null,
          isStreaming: false,
        }
      },
      undefined,
      'stopStreaming'
    ),

  /**
   * 清除指定 thread 的所有流式缓冲
   * 从 streamingItems 中移除所有 threadId 匹配的条目。
   * 若无条目被移除，返回空 patch 避免不必要的渲染。
   */
  clearStreaming: (threadId: string) =>
    set(
      (state: StreamingState) => {
        const nextItems: Record<string, StreamingItem> = {}
        let removed = false
        for (const [key, item] of Object.entries(state.streamingItems)) {
          if (item.threadId === threadId) {
            removed = true
          } else {
            nextItems[key] = item
          }
        }
        if (!removed) {
          return {}
        }
        return { streamingItems: nextItems }
      },
      undefined,
      'clearStreaming'
    ),

  /**
   * 获取指定 itemId 的流式内容（非响应式）
   * 使用 get() 读取最新状态，适用于回调中的一次性读取。
   * 组件中如需响应式订阅，应使用 useStreamingStore 选择器：
   *   useStreamingStore(s => s.streamingItems[itemId])
   */
  getStreamingItem: (itemId: string) => get().streamingItems[itemId],

  /**
   * 将流式内容转为最终 Message 并从缓冲区移除（原子操作）。
   *
   * 读取 item → 构建 Message → 移除 item 全部在同一个 set() 回调内完成，
   * 避免 get()/set() 分离导致的 TOCTOU 竞态（读取与写入之间存在时间窗口，
   * 并发调用可能读到旧值）。
   *
   * 返回 Message 供调用方归档到 TanStack Query 缓存（由 ConversationArea 调用）。
   * 若 itemId 不存在则返回 undefined。
   */
  resolveStreamingItem: (itemId: string) => {
    // 在 set 外部声明，便于回调内赋值后外部返回
    let resolvedMessage: Message | undefined
    set(
      (state: StreamingState) => {
        const item = state.streamingItems[itemId]
        // 不存在则无操作（返回空 patch，与 stopStreaming/clearStreaming 的 no-op 约定一致）
        if (!item) return {}
        // 在 set 内部构建 Message，确保原子性（避免 get/set 之间的竞态）
        resolvedMessage = buildMessageFromItem(item)
        // 过滤掉目标 itemId（避免动态 delete，使用不可变重建）
        const nextItems: Record<string, StreamingItem> = {}
        for (const [key, value] of Object.entries(state.streamingItems)) {
          if (key !== itemId) {
            nextItems[key] = value
          }
        }
        return { streamingItems: nextItems }
      },
      undefined,
      'resolveStreamingItem'
    )
    return resolvedMessage
  },
})

export const useStreamingStore = create<StreamingState>()(
  devtools(streamingStoreCreator, {
    name: 'streaming-store',
  })
)
