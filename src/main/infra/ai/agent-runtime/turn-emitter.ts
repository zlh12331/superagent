// src/main/infra/ai/agent-runtime/turn-emitter.ts
// 回合事件发射器：类型安全的 on/emit（对齐 qwen AgentEventEmitter）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 回合事件的生产/订阅解耦：AgentRuntime 产出事件，agent-service 与
//   Transcript 订阅消费，互不感知
// - on 返回 unsubscribe 函数（订阅方负责在会话结束时取消，防泄漏）
//
// 设计（对齐 qwen agent-events.ts 的 AgentEventEmitter）：
// - 按事件类型分桶存储监听器，emit 时只通知对应类型
// - 事件为不可变对象（契约类型只读）
// ──────────────────────────────────────────────────────────────

import type { TurnEvent, TurnEventMap, TurnEventType } from '@code-agent/shared/main';

/**
 * 回合事件发射器（会话级：每个活跃对话一个实例）
 */
export class TurnEventEmitter {
  private readonly listeners = new Map<TurnEventType, Set<(event: TurnEvent) => void>>();
  /** 全类型监听器（onAny 注册） */
  private readonly anyListeners = new Set<(event: TurnEvent) => void>();

  /**
   * 订阅指定类型的事件
   *
   * @param type 事件类型（TurnEventType）
   * @param listener 监听器（payload 已按类型收窄）
   * @returns unsubscribe 函数（会话结束时必须调用，防内存泄漏）
   */
  on<E extends TurnEventType>(type: E, listener: (event: TurnEventMap[E]) => void): () => void {
    const bucket = this.listeners.get(type) ?? new Set<(event: TurnEvent) => void>();
    const wrapped = listener as (event: TurnEvent) => void;
    bucket.add(wrapped);
    this.listeners.set(type, bucket);
    return () => {
      bucket.delete(wrapped);
      if (bucket.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * 发布事件（同步通知该类型的所有监听器）
   *
   * 监听器抛错不阻断其他监听器（本层不记录日志，异常由上层处理）。
   */
  emit(event: TurnEvent): void {
    // 先通知全类型监听器（onAny），再通知按类型分桶的监听器
    for (const anyListener of this.anyListeners) {
      try {
        anyListener(event);
      } catch {
        // 隔离单个监听器异常，保证其他监听器正常收到事件
      }
    }
    const bucket = this.listeners.get(event.type);
    if (bucket === undefined || bucket.size === 0) {
      return;
    }
    for (const listener of bucket) {
      try {
        listener(event);
      } catch {
        // 隔离单个监听器异常，保证其他监听器正常收到事件
      }
    }
  }

  /**
   * 订阅全部类型事件（类级转发：IM 桥接等跨会话监听方）
   *
   * @returns unsubscribe 函数
   */
  onAny(listener: (event: TurnEvent) => void): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** 当前订阅总数（测试断言用） */
  getListenerCount(): number {
    let count = 0;
    for (const bucket of this.listeners.values()) {
      count += bucket.size;
    }
    return count + this.anyListeners.size;
  }
}
