// src/main/infra/ai/agent/hook-registry.ts
// 生命周期钩子注册表（工具执行前后事件点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 按事件名注册/注销钩子（pre-tool-use / post-tool-use）
// - 触发时做错误隔离：单个钩子抛错只记日志，不阻断其他钩子与工具主流程
// - 供扩展（审计、通知、自定义逻辑）挂载工具生命周期
//
// 接入点（当前唯一生产触发方 = tools/tool-executor.ts）：
// - pre-tool-use：execute 阶段 3.5，await 后据返回值决定是否阻断（false → 拒绝执行）
// - post-tool-use：仅「工具执行成功」分支触发，且为 fire-and-forget（void，不 await）
//   ⇒ 失败分支（catch）不触发该事件，故 HookContext.error 目前无生产填充
// - 当前生产侧无任何 register 调用（只有单测），本模块作为预留扩展点存在
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/hooks/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// HookEventName 事件点语义，按我们的技术栈收敛重写：
// - 移除脚本执行器（ChildProcess）/ TaskStatus / ToolArtifact 等强耦合依赖（不搬运）
// - 收敛为纯函数钩子（同步/异步 handler），覆盖工具执行前后事件点
// - 回合级事件点（turn-start/end）由现有 onTurnEvent 类级总线覆盖，不重复实现
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';

/**
 * 钩子事件名常量表（对齐 qwen HookEventName 的收敛子集）
 *
 * 字面量取值即传给 handler 的事件标识，与下方同名类型共用标识符
 * （const 与 type 可同名合并，type 从常量表取值派生）。
 */
export const HookEventName = {
  /** 工具执行前：trigger 返回值可被下游当作「是否放行」判定 */
  PRE_TOOL_USE: 'pre-tool-use',
  /** 工具执行后：携带工具结果（见 HookContext.result） */
  POST_TOOL_USE: 'post-tool-use',
} as const;

/** 钩子事件名联合类型（'pre-tool-use' | 'post-tool-use'，从 HookEventName 常量表派生） */
export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

/** 钩子上下文（触发时交给每个 handler 的事件载荷；字段由调用方按事件点填充） */
export interface HookContext {
  /** 会话 id（工具所属回合） */
  readonly sessionId: string;
  /** 工具调用 id（与 tool-result 事件配对） */
  readonly toolCallId: string;
  /** 工具名称 */
  readonly toolName: string;
  /** 工具入参（结构由工具 schema 决定，故为 unknown） */
  readonly input: unknown;
  /**
   * 工具执行结果（post-tool-use 场景携带）
   *
   * 声明为可选：pre-tool-use 时无结果；post-tool-use 由调用方按需填。
   * 注意当前生产接入点只在「执行成功」分支触发 post-tool-use，
   * 因此该字段实际承载成功结果（ToolResult）。
   */
  readonly result?: unknown;
  /** 工具执行错误（预留：供未来在失败分支触发 post-tool-use 时填充） */
  readonly error?: unknown;
}

/**
 * 钩子处理器
 *
 * 同步或异步均可（trigger 内 await 统一收口）。
 *
 * 返回值语义（2026-10-08 升级）：
 * - `false`：阻止（pre-tool-use），原因缺失（兼容旧 handler）
 * - `HookDenial`：阻止并携带原因——用户可见（工具错误消息含该原因），
 *   避免"被钩子阻止"这类无信息的提示
 * - `true` / `undefined`：放行
 */
export type HookHandler = (
  context: HookContext,
) => boolean | HookDenial | undefined | Promise<boolean | HookDenial | undefined>;

/**
 * 钩子阻断决定（携带原因）
 *
 * 为什么不是 boolean：`tool-executor` 的阻断出口此前只能硬编码
 * "工具执行被钩子阻止：<toolName>"——用户配了钩子拦截却看不到是哪条规则
 * 拦的（可诊断性缺口）。升级为对象后，钩子的阻断原因直达工具错误消息与 UI。
 */
export interface HookDenial {
  /** 固定为 false 的判别位（便于 handler 返回 `{ allowed: false, reason }` 字面量） */
  readonly allowed: false;
  /** 阻断原因（展示给用户；省略时回落通用文案） */
  readonly reason?: string;
}

/** 判定 handler 返回值是否为「携带原因的阻断」 */
function isDenial(value: unknown): value is HookDenial {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { allowed?: unknown }).allowed === false
  );
}

/**
 * trigger 的阻断结果（携带钩子提供的原因）
 *
 * reason 为空串时表示"阻断但未提供原因"（兼容旧 boolean handler），
 * 调用方回落通用文案而不显示空括号。
 */
export interface HookBlock {
  /** 钩子提供的阻断原因（可能为空串） */
  readonly reason: string;
}

/**
 * 生命周期钩子注册表
 *
 * 按事件名分桶（Map<事件, Set<handler>>），Set 天然去重：同一 handler 重复
 * register 只计一次。单例经下方 hookRegistry 导出，由 ToolExecutor 触发。
 */
export class HookRegistry {
  private readonly handlers = new Map<HookEventName, Set<HookHandler>>();

  /**
   * 注册钩子
   *
   * @returns 取消注册函数；重复调用幂等（bucket.delete 对已删项为 no-op）
   *
   * 空桶清理：注销后若该事件的 bucket 已空，则从 Map 删除该事件条目，
   * 避免长期持有空 Set（同时让 getHandlerCount 语义保持「当前有效钩子数」）。
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
   * 触发钩子（顺序执行桶内全部 handler；错误隔离：单个钩子异常不阻断其他钩子与主流程）
   *
   * 语义：任一 handler 阻断（返回 false 或 HookDenial）→ 整体阻断；
   * **不短路**——后续 handler 仍会执行（保证所有钩子都能观测到事件），
   * 异常仅记日志并继续。
   *
   * @returns `null` = 放行；`{ reason }` = 阻断（reason 为钩子提供的原因，
   *   未提供时为空串，调用方回落通用文案）。用判别式对象而非 boolean：
   *   调用方需要携带阻断原因（2026-10-08，此前 boolean 让错误消息只能硬编码）
   */
  async trigger(event: HookEventName, context: HookContext): Promise<HookBlock | null> {
    const bucket = this.handlers.get(event);
    if (bucket === undefined || bucket.size === 0) {
      return null;
    }
    let block: HookBlock | null = null;
    for (const handler of bucket) {
      try {
        const result = await handler(context);
        // 首个阻断即采纳（后续阻断不覆盖，保持原因可追溯）；不短路仍执行其余 handler
        if (result === false) {
          block ??= { reason: '' }; // 兼容旧 handler：只表达"阻断"，无原因
        } else if (isDenial(result)) {
          block ??= { reason: result.reason ?? '' };
        }
      } catch (err: unknown) {
        // 钩子异常隔离：记录日志，不阻断工具执行与其他钩子
        logger.error({ event, toolName: context.toolName, error: err }, '钩子执行异常');
      }
    }
    return block;
  }

  /** 当前钩子总数（跨事件求和；测试断言用） */
  getHandlerCount(): number {
    let count = 0;
    for (const bucket of this.handlers.values()) {
      count += bucket.size;
    }
    return count;
  }
}

/**
 * 模块级单例（ToolExecutor 的 pre/post-tool-use 触发方与之共用同一实例）
 *
 * 与 SubagentManager 的 init 单例不同，此处直接实例化：注册表无外部依赖
 * （仅 logger），构造即用，无需容器注入。
 */
export const hookRegistry = new HookRegistry();
