/**
 * Mock 流式事件发射器
 *
 * 在浏览器开发模式下模拟 codex-rs 后端的流式事件序列，
 * 让 ConversationArea 的 universalListen 能接收到完整的 turn 生命周期事件。
 *
 * ## 事件序列
 *
 * simulateTurn 发射以下事件（通过 mockEventBus.emit）：
 *
 * 1. turn/started          — 轮次开始（触发 startStreaming）
 * 2. item/started          — 条目开始（后端开始生成新消息）
 * 3. item/agentMessage/delta ×N — 文本增量（触发 appendDelta，逐字输出）
 * 4. item/completed        — 条目完成（触发 resolveStreamingItem + invalidate）
 * 5. turn/completed        — 轮次完成（触发 stopStreaming + invalidate）
 *
 * ## 时序设计
 *
 * - delta 间隔 50ms，模拟真实流式输出节奏
 * - item/completed 在所有 delta 结束后 100ms 发射
 * - turn/completed 在 item/completed 后 100ms 发射
 * - 使用 setTimeout 异步发射，避免阻塞 startTurn 的 return
 *
 * @see src/lib/codex/mock/event-bus.ts — mockEventBus.emit
 * @see src/lib/codex/notifications.ts — NotificationMethod 事件名常量
 * @see src/features/conversation/ConversationArea.tsx — 事件消费方
 */

import type { ThreadId, TurnId } from '../types'
import { mockEventBus } from './event-bus'

/**
 * 模拟的 codex 回复文本（分段发射 delta）。
 *
 * 包含典型 codex 回复的结构：问题分析 + 解决方案 + 代码示例。
 */
const MOCK_REPLY_TEXT =
  '我来看一下这个问题。根据错误日志，bridge.rs 的事件循环在处理 WebSocket 消息时出现了死锁。\n\n' +
    '问题出在 `emit` 函数持有锁的同时调用了回调，回调又尝试获取同一把锁。' +
    '解决方案是将回调调用移到锁的作用域外：\n\n' +
    '```rust\nlet callbacks = listeners.lock().unwrap();\nlet snapshot = callbacks.clone();\ndrop(callbacks);  // 显式释放锁\nfor cb in snapshot { cb(payload); }\n```\n\n' +
    '这样回调执行时不再持有锁，避免了重入死锁。'

/** delta 发射间隔（毫秒），模拟真实流式输出节奏 */
const DELAY_DELTA_MS = 50
/** item/completed 在所有 delta 后的延迟（毫秒） */
const DELAY_ITEM_COMPLETED_MS = 100
/** turn/completed 在 item/completed 后的延迟（毫秒） */
const DELAY_TURN_COMPLETED_MS = 100

/**
 * 将文本按固定长度切分为 delta 块。
 *
 * 模拟后端逐 token 推送的行为，每块约 3-5 个字符。
 *
 * @param text — 完整文本
 * @param chunkSize — 每块字符数（默认 4）
 * @returns 文本块数组
 */
function splitIntoDeltas(text: string, chunkSize = 4): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

/**
 * 模拟完整的 turn 生命周期事件序列。
 *
 * 在 startTurn mock 分支中调用，通过 mockEventBus 发射事件，
 * ConversationArea 的 universalListen 自动接收并驱动 streaming-store。
 *
 * ## 副作用
 *
 * 通过 setTimeout 异步发射事件，调用方无需 await。
 * 事件发射后会触发 ConversationArea 的 streaming-store 更新，
 * 实现"逐字输出"的流式效果。
 *
 * @param threadId — 线程 ID
 * @param turnId — 轮次 ID
 * @param _userMessage — 用户消息（当前未使用，保留以备未来根据消息内容生成不同回复）
 */
export function simulateTurn(
  threadId: ThreadId,
  turnId: TurnId,
  _userMessage: string
): void {
  // 生成唯一的 item ID（模拟后端的 ThreadItem ID）
  const itemId = `item-${Date.now()}`
  // 记录开始时间（模拟后端的 startedAtMs）
  const startedAtMs = Date.now()

  // 1. 发射 turn/started 事件（触发 ConversationArea 的 startStreaming）
  mockEventBus.emit('codex:notification', {
    method: 'turn/started',
    params: { threadId, turnId, startedAtMs },
  })

  // 2. 发射 item/started 事件（后端开始生成新消息条目）
  mockEventBus.emit('codex:notification', {
    method: 'item/started',
    params: {
      threadId,
      turnId,
      item: { id: itemId, type: 'message' },
      startedAtMs,
    },
  })

  // 3. 分段发射 item/agentMessage/delta 事件（触发 appendDelta 逐字输出）
  const deltas = splitIntoDeltas(MOCK_REPLY_TEXT)
  deltas.forEach((delta, index) => {
    setTimeout(() => {
      mockEventBus.emit('codex:notification', {
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId, delta },
      })
    }, (index + 1) * DELAY_DELTA_MS)
  })

  // 所有 delta 发射完成的总耗时
  const allDeltasDuration = deltas.length * DELAY_DELTA_MS

  // 4. 发射 item/completed 事件（触发 resolveStreamingItem + 乐观更新 + invalidate）
  const itemCompletedMs = allDeltasDuration + DELAY_ITEM_COMPLETED_MS
  setTimeout(() => {
    mockEventBus.emit('codex:notification', {
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: MOCK_REPLY_TEXT }],
        },
        completedAtMs: Date.now(),
      },
    })
  }, itemCompletedMs)

  // 5. 发射 turn/completed 事件（触发 stopStreaming + clearStreaming + invalidate）
  setTimeout(() => {
    mockEventBus.emit('codex:notification', {
      method: 'turn/completed',
      params: {
        threadId,
        turnId,
        turn: { id: turnId, status: 'completed' },
        completedAtMs: Date.now(),
      },
    })
  }, itemCompletedMs + DELAY_TURN_COMPLETED_MS)
}
