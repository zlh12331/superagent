// token-limits.ts：输出 token 上限夹紧——模型能力上限 × 用户 ceiling × 上下文剩余空间三者取小
export const OUTPUT_TOKEN_CEILING: number = 64_000;

export const MIN_OUTPUT_TOKENS: number = 4_000;

/** 上下文窗口的 5%（至少 1 万 token）留作输出余量防溢出 */
export function outputClampMargin(contextWindowSize: number): number {
  return Math.max(10_000, Math.round(0.05 * contextWindowSize));
}

/**
 * 输出 token 夹紧：无窗口信息直接用 ceiling；有窗口按剩余空间再夹；
 * 结果保底 MIN_OUTPUT_TOKENS（除非 ceiling 本身更小）
 */
export function clampOutputTokens(options: {
  readonly ceiling: number | undefined;
  readonly modelMaxOutputTokens: number | undefined;
  readonly contextWindowSize: number | undefined;
  readonly promptTokens: number;
}): number | undefined {
  const { ceiling, modelMaxOutputTokens, contextWindowSize, promptTokens } = options;
  const capabilityCap = modelMaxOutputTokens ?? OUTPUT_TOKEN_CEILING;
  const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);

  if (contextWindowSize === undefined) {
    return effectiveCeiling;
  }

  const room = contextWindowSize - promptTokens - outputClampMargin(contextWindowSize);
  const clamped = Math.min(effectiveCeiling, room);
  return effectiveCeiling < MIN_OUTPUT_TOKENS
    ? effectiveCeiling
    : Math.max(clamped, MIN_OUTPUT_TOKENS);
}
