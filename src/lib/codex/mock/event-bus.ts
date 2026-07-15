/**
 * Mock 事件总线
 *
 * 模拟 Tauri 的 emit/listen 语义，在浏览器开发模式下
 * 为 universalListen 和 simulateTurn 提供事件传递通道。
 *
 * ## 工作原理
 *
 * 1. simulateTurn 通过 mockEventBus.emit('codex:notification', payload)
 *    发射流式事件
 * 2. ConversationArea 的 universalListen 在浏览器模式下注册到 mockEventBus
 * 3. mockEventBus 收到 emit 后遍历监听器并调用，实现与 Tauri listen 相同的语义
 *
 * ## 与 Tauri 的差异
 *
 * - Tauri listen 返回 Promise<UnlistenFn>，mockEventBus.listen 同步返回 unlisten
 *   universalListen 已处理这个差异（包装为 Promise）
 * - Tauri 事件支持跨进程，mockEventBus 仅限同进程（浏览器场景足够）
 * - mockEventBus 不支持 once 语义（当前无此需求）
 *
 * @see src/lib/codex/mock/listen.ts — universalListen 统一监听
 * @see src/lib/codex/mock/event-emitter.ts — simulateTurn 流式事件发射器
 */

/** 事件回调函数类型（与 Tauri listen 的回调签名对齐） */
type EventCallback<T> = (payload: { event: string; payload: T }) => void

/**
 * Mock 事件总线
 *
 * 内部用 Map<eventName, Set<callback>> 存储监听器，
 * emit 时遍历对应事件的所有监听器并调用。
 */
class MockEventBus {
  /** 监听器存储：事件名 → 回调集合 */
  private listeners = new Map<string, Set<EventCallback<unknown>>>()

  /**
   * 发射事件（模拟 Tauri emit）。
   *
   * 遍历指定事件的所有监听器并调用，传递 payload。
   * 如果没有监听器，事件被静默丢弃（与 Tauri 行为一致）。
   *
   * @param event — 事件名称（如 'codex:notification'）
   * @param payload — 事件负载数据
   */
  emit<T>(event: string, payload: T): void {
    const callbacks = this.listeners.get(event)
    if (!callbacks) return
    // 复制一份再遍历，避免回调中取消监听导致 Set 迭代异常
    for (const cb of [...callbacks]) {
      try {
        cb({ event, payload })
      } catch (err) {
        // 捕获回调异常，避免一个监听器报错影响其他监听器
        console.error(`[mockEventBus] 监听器执行异常 (${event}):`, err)
      }
    }
  }

  /**
   * 注册事件监听器（模拟 Tauri listen）。
   *
   * @param event — 事件名称
   * @param callback — 事件回调，接收 { event, payload } 结构
   * @returns unlisten 函数，调用后取消监听
   */
  listen<T>(event: string, callback: EventCallback<T>): () => void {
    let callbacks = this.listeners.get(event)
    if (!callbacks) {
      callbacks = new Set()
      this.listeners.set(event, callbacks)
    }
    // 类型擦除：Set<EventCallback<unknown>> 存储，调用时由 emit 透传
    callbacks.add(callback as EventCallback<unknown>)

    // 返回 unlisten 函数，从 Set 中移除该回调
    return () => {
      const set = this.listeners.get(event)
      if (set) {
        set.delete(callback as EventCallback<unknown>)
        // Set 为空时清理 Map 条目，避免内存泄漏
        if (set.size === 0) {
          this.listeners.delete(event)
        }
      }
    }
  }

  /**
   * 清除指定事件的所有监听器（测试用）。
   *
   * 生产代码不应调用此方法。
   *
   * @param event — 事件名称（为空时清除所有事件的监听器）
   */
  clear(event?: string): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }
}

/**
 * Mock 事件总线单例
 *
 * 全局共享一个实例，确保 emit 和 listen 操作同一个 Map。
 * 在浏览器开发模式下被 universalListen 和 simulateTurn 使用。
 */
export const mockEventBus = new MockEventBus()
