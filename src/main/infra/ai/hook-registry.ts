// src/main/infra/ai/hook-registry.ts
// 生命周期钩子注册表（工具执行前后事件点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册/触发钩子（pre-tool-use / post-tool-use）
// - 错误隔离：单个钩子抛错不阻断工具执行与其他钩子
// - 供扩展（审计、通知、自定义逻辑）挂载工具生命周期
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/hooks/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// HookEventName 事件点语义，按我们的技术栈收敛重写：
// - 移除脚本执行器（ChildProcess）/ TaskStatus / ToolArtifact 等强耦合依赖（不搬运）
// - 收敛为纯函数钩子（同步/异步 handler），覆盖工具执行前后事件点
// - 回合级事件点（turn-start/end）由现有 onTurnEvent 类级总线覆盖，不重复实现
// ──────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';

/** 钩子事件名（对齐 qwen HookEventName 的收敛子集） */
export const HookEventName = {
  /** 工具执行前（可中断：返回 false 阻止执行） */
  PRE_TOOL_USE: 'pre-tool-use',
  /** 工具执行后（含结果） */
  POST_TOOL_USE: 'post-tool-use',
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

/** 钩子上下文（事件携带数据） */
export interface HookContext {
  /** 会话 id */
  readonly sessionId: string;
  /** 工具调用 id */
  readonly toolCallId: string;
  /** 工具名称 */
  readonly toolName: string;
  /** 工具入参 */
  readonly input: unknown;
  /** 工具执行结果（post-tool-use 时携带；成功 = output，失败 = undefined） */
  readonly result?: unknown;
  /** 工具执行错误（post-tool-use 失败时携带） */
  readonly error?: unknown;
}

/** 钩子处理器（同步或异步；pre-tool-use 返回 false 可阻止执行） */
export type HookHandler = (
  context: HookContext,
) => boolean | undefined | Promise<boolean | undefined>;

/**
 * 生命周期钩子注册表（模块单例）
 */
export class HookRegistry {
  private readonly handlers = new Map<HookEventName, Set<HookHandler>>();

  /**
   * 注册钩子（返回取消注册函数）
   */
  register(event: HookEventName, handler: HookHandler): () => void {
    const bucket = this.handlers.get(event) ?? new Set<HookHandler>();
    bucket.add(handler);
    this.handlers.set(event, bucket);
    return () => {
      bucket.delete(handler);
      if (bucket.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  /**
   * 触发钩子（错误隔离：单个钩子异常不阻断其他钩子与主流程）
   *
   * @returns pre-tool-use 场景：false = 有钩子阻止执行
   */
  async trigger(event: HookEventName, context: HookContext): Promise<boolean> {
    const bucket = this.handlers.get(event);
    if (bucket === undefined || bucket.size === 0) {
      return true;
    }
    let allow = true;
    for (const handler of bucket) {
      try {
        const result = await handler(context);
        if (result === false) {
          allow = false;
        }
      } catch (err: unknown) {
        // 钩子异常隔离：记录日志，不阻断工具执行与其他钩子
        logger.error({ event, toolName: context.toolName, error: err }, '钩子执行异常');
      }
    }
    return allow;
  }

  /** 当前钩子总数（测试断言用） */
  getHandlerCount(): number {
    let count = 0;
    for (const bucket of this.handlers.values()) {
      count += bucket.size;
    }
    return count;
  }
}

/** 模块级单例（ServiceContainer 与 ToolExecutor 共用） */
export const hookRegistry = new HookRegistry();
