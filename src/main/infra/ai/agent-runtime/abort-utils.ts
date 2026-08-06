// src/main/infra/ai/agent-runtime/abort-utils.ts
// 中断信号工具：组合信号 + 可清理超时信号（主流程与 side query 共用）
// ──────────────────────────────────────────────────────────────
// 背景：主回合（agent/chat streamText）原仅接用户中断信号；
// 模型级总时长超时（generationConfig.timeoutMs）接入后需组合语义。
// 从 llm-client 提取共享（llm-client 内部实现改为导入本模块，单一真源）。
// ──────────────────────────────────────────────────────────────

/**
 * 组合多个中断信号（AbortSignal.any 封装）
 *
 * 用于：用户中断信号 + 模型级超时信号的组合，任一触发即中断。
 * 全 undefined 时返回 undefined（不传 abortSignal）；单信号时原样返回。
 */
export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) {
    return undefined;
  }
  if (defined.length === 1) {
    return defined[0];
  }
  return AbortSignal.any(defined);
}

/**
 * 可手动清理的超时信号（替代 AbortSignal.timeout）
 *
 * AbortSignal.timeout 的定时器仅在 abort 时清理；请求成功（未超时）时
 * 定时器会残留到超时时刻。本封装返回 clear()，调用方在请求结束后
 * 立即清理，避免长超时 × 高频调用导致定时器堆积。
 */
export function createTimeoutSignal(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly clear: () => void;
} {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}
