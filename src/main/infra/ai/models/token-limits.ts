export const OUTPUT_TOKEN_CEILING: number = 64_000;

export const MIN_OUTPUT_TOKENS: number = 4_000;

export function outputClampMargin(contextWindowSize: number): number {
  return Math.max(10_000, Math.round(0.05 * contextWindowSize));
}

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
