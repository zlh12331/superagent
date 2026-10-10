/**
 * 组合多个中断信号（AbortSignal.any 封装）
 *
 * 用于：用户中断信号 + 模型级超时信号的组合，任一触发即中断。
 * 全 undefined 时返回 undefined（不传 abortSignal）；单信号时原样返回
 * （不为单信号多包一层组合，保持 signal 身份可判等）。
 *
 * 不变量：组合信号本身无法再手动 abort（AbortSignal.any 的复合信号无
 * 清理通道）——超时定时器的及时回收靠 createTimeoutSignal 的 clear()，
 * 不在本层解决。
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
 *
 * 主回合接线：turn-assembly 仅当模型配置 timeoutMs 才创建本信号（try/finally
 * 内创建与清理，谁创建谁清理）；side query 侧另有全局默认时长兜底（llm-client）。
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
