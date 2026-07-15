/**
 * Universal listen — 统一事件监听
 *
 * 根据运行环境自动选择 Tauri listen 或 mockEventBus.listen，
 * 让调用方无需关心当前环境。
 *
 * ## 使用场景
 *
 * ConversationArea 监听 codex:notification 事件时使用 universalListen：
 * - Tauri 环境：调用 @tauri-apps/api/event 的 listen
 * - 浏览器环境：调用 mockEventBus.listen，接收 simulateTurn 发射的事件
 *
 * 这样浏览器开发模式下也能调试流式消息、工具卡、审批等交互。
 *
 * @see src/lib/codex/mock/event-bus.ts — mockEventBus 实现
 * @see src/features/conversation/ConversationArea.tsx — 主要调用方
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/env'
import { mockEventBus } from './event-bus'

/**
 * 统一事件监听函数。
 *
 * Tauri 环境调用原生 listen，浏览器环境调用 mockEventBus.listen。
 * 两者都返回 Promise<UnlistenFn>，调用方可在 cleanup 中直接调用返回的函数。
 *
 * @param event — 事件名称（如 'codex:notification'）
 * @param callback — 事件回调，接收 payload
 * @returns unlisten 函数（Promise 包装，与 Tauri listen 签名一致）
 */
export async function universalListen<T>(
  event: string,
  callback: (payload: T) => void
): Promise<UnlistenFn> {
  if (isTauri()) {
    // Tauri 环境：使用原生事件监听
    return await listen<T>(event, e => {
      callback(e.payload)
    })
  }

  // 浏览器环境：注册到 mockEventBus，接收 simulateTurn 等发射的事件
  // mockEventBus.listen 返回同步 unlisten，这里包装为 Promise 以统一签名
  return Promise.resolve(
    mockEventBus.listen<T>(event, e => {
      callback(e.payload)
    })
  )
}
