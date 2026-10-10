// abort-utils.ts：中止信号工具——多信号合并 + 可清理的超时信号
/** 合并多个信号（undefined 忽略；单信号直接返回省一层包装；空集返回 undefined 表示无中止源） */
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

/** 超时中止信号：clear 须由调用方在提前完成时执行（否则 timer 挂到超时点才释放） */
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
