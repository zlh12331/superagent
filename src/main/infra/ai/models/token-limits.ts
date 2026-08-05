// src/main/infra/ai/models/token-limits.ts
// 输出 token 预算钳制（移植自 qwen-code core/tokenLimits.ts 的设计）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 保证 `prompt + max_tokens ≤ contextWindow` 不变量（防止请求 400）
// - 输出请求上限：min(用户配置, OUTPUT_TOKEN_CEILING, 窗口余量)
// - 窗口余量 = max(10K, 5% × 窗口)（吸收 prompt 估算误差 + system/tool/schema 开销）
// - 下限 MIN_OUTPUT_TOKENS：窗口快满时仍请求至少 4K，压缩交给上层
// ──────────────────────────────────────────────────────────────

/** 自动输出请求的封顶值（非用户配置的上限；用户显式设置可突破到模型真实上限） */
export const OUTPUT_TOKEN_CEILING: number = 64_000;

/** 钳制后的最低输出请求（窗口几乎被 prompt 占满时仍保证有输出空间） */
export const MIN_OUTPUT_TOKENS: number = 4_000;

/**
 * 安全余量：从窗口减去后剩余空间才是输出预算
 *
 * 吸收 prompt 估算误差与 system/tool/schema 等未被 prompt 计数覆盖的开销。
 * 保守策略：余量宁多勿少（余量过大只会在压缩临界点少输出一点，
 * 余量过小则 reintroduce prompt + max_tokens > window 的 400）。
 */
export function outputClampMargin(contextWindowSize: number): number {
  return Math.max(10_000, Math.round(0.05 * contextWindowSize));
}

/**
 * 钳制输出 token 请求
 *
 * 结果 = max(MIN_OUTPUT_TOKENS, min(ceiling, window − prompt − margin))
 *
 * @param ceiling 输出上限：用户/模型条目显式配置的 maxTokens；缺省用模型能力上限
 * @param modelMaxOutputTokens 模型能力上限（maxOutputTokens，如 DeepSeek v4 的 384K）；
 *   未配置时回退 OUTPUT_TOKEN_CEILING
 * @param contextWindowSize 模型上下文窗口（未配置时不做窗口钳制）
 * @param promptTokens 估算的 prompt 大小（含 system）
 * @returns 钳制后的 maxOutputTokens；无窗口信息时返回有效上限（可能 undefined）
 */
export function clampOutputTokens(options: {
  readonly ceiling: number | undefined;
  readonly modelMaxOutputTokens: number | undefined;
  readonly contextWindowSize: number | undefined;
  readonly promptTokens: number;
}): number | undefined {
  const { ceiling, modelMaxOutputTokens, contextWindowSize, promptTokens } = options;
  // 模型能力上限优先（如 DeepSeek v4 384K）；缺省回退全局默认 64K
  const capabilityCap = modelMaxOutputTokens ?? OUTPUT_TOKEN_CEILING;
  const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);

  // 无窗口信息：无法做窗口钳制，仅应用能力上限
  if (contextWindowSize === undefined) {
    return effectiveCeiling;
  }

  const room = contextWindowSize - promptTokens - outputClampMargin(contextWindowSize);
  const clamped = Math.min(effectiveCeiling, room);
  // 下限只钳制窗口余量（room），不抬升用户显式 ceiling：
  // 用户显式设置的小 maxTokens（如 100）应被尊重（对标 qwen tokenLimits 设计）
  return effectiveCeiling < MIN_OUTPUT_TOKENS
    ? effectiveCeiling
    : Math.max(clamped, MIN_OUTPUT_TOKENS);
}
