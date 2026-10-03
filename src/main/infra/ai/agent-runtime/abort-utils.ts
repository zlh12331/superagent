// src/main/infra/ai/agent-runtime/abort-utils.ts
// 中断信号工具：组合信号 + 可清理超时信号（主回合与 side query 两路共用）
// ──────────────────────────────────────────────────────────────
// 背景：主回合（agent streamText）原仅接用户中断信号；模型级总时长超时
// （generationConfig.timeoutMs）接入后需组合语义。从 llm-client 提取共享
// （llm-client 内部实现改为导入本模块，单一真源）。
//
// 生产调用方（均深度导入，不经 index 桶）：
// - turn-assembly：主回合超时信号 + 用户中断合并（仅当模型配置 timeoutMs 才创建
//   信号；生产常态未配置，见 turn-assembly 第 2 步的登记说明）
// - llm-client runSideQuery：side query 模型级超时 + 用户信号合并（有全局默认兜底）
// ──────────────────────────────────────────────────────────────

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
