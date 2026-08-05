// src/main/infra/ai/models/reasoning-effort.ts
// 思考强度阶梯：统一档位 + 归一化 + 按模型能力钳制
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义五档思考强度（low/medium/high/xhigh/max），对齐 qwen-code 的
//   reasoning-effort 阶梯（源自 openclaw thinking-level 模型）
// - normalizeReasoningEffort：用户自由输入 → 规范档位
// - clampReasoningEffort：请求档位 → 模型实际支持的档位（钳制）
// - DeepSeek v4 官方映射表（api-docs.deepseek.com/zh-cn/guides/thinking_mode）：
//   | 请求档位 | v4-flash 实际 | v4-pro 实际 |
//   | low    | low          | high        |
//   | high   | high         | high        |
//   | xhigh  | high         | max         |
//   | max    | max          | max         |
// ──────────────────────────────────────────────────────────────

/**
 * 统一思考强度档位（弱 → 强）
 *
 * 供应商支持子集不同、线协议字段不同（reasoning_effort / output_config.effort 等），
 * 本层提供统一阶梯；供应商适配时用 clampReasoningEffort 钳制到模型支持的档位。
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 有序阶梯（弱 → 强），驱动归一化与钳制 */
export const REASONING_EFFORT_TIERS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * 档位数值强度（钳制比较用）
 *
 * 间隔刻意留白：未来中间档（如 minimal）可插入而不必重排。
 */
export const REASONING_EFFORT_RANKS: Record<ReasoningEffort, number> = {
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70,
};

/**
 * 归一化用户自由输入为规范档位
 *
 * 接受常见别名（x-high / extra-high / maximum / med 等），
 * 无法识别的输入返回 undefined（调用方可提示错误）。
 */
export function normalizeReasoningEffort(raw?: string | null): ReasoningEffort | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'string') {
    return undefined;
  }
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  switch (key) {
    case 'low':
      return 'low';
    case 'medium':
    case 'med':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'extrahigh':
      return 'xhigh';
    case 'max':
    case 'maximum':
      return 'max';
    default:
      return undefined;
  }
}

/**
 * 把请求档位钳制到模型实际支持的档位
 *
 * 基于数值强度（对标 openclaw clampThinkingLevel）：
 * - 请求档位受支持 → 原样保留
 * - 否则优先取下一个更强的受支持档位；没有更强档位时取最强可用档
 *   （xhigh/max 被不支持时自然封顶到模型天花板，不抬高成本）
 *
 * @param requested 请求档位
 * @param supported 模型支持的档位（缺省 = 全阶梯，不钳制）
 */
export function clampReasoningEffort(
  requested: ReasoningEffort,
  supported?: readonly ReasoningEffort[],
): ReasoningEffort {
  const supportedSet =
    supported !== undefined && supported.length > 0 ? supported : REASONING_EFFORT_TIERS;
  if (supportedSet.includes(requested)) {
    return requested;
  }
  const requestedRank = REASONING_EFFORT_RANKS[requested];
  const ranked = [...supportedSet].sort(
    (a, b) => REASONING_EFFORT_RANKS[a] - REASONING_EFFORT_RANKS[b],
  );
  // 取 ≥ 请求档位的最小支持档；没有则取最强可用档（封顶）
  const stronger = ranked.find((tier) => REASONING_EFFORT_RANKS[tier] >= requestedRank);
  if (stronger !== undefined) {
    return stronger;
  }
  // noUncheckedIndexedAccess 防御：supportedSet 非空（length > 0 分支已保证）
  return ranked[ranked.length - 1] ?? requested;
}

/**
 * DeepSeek v4-flash 官方映射表（逐档映射，非通用 clamp 语义）
 *
 * 官方映射（thinking_mode 文档）：low→low / high→high / xhigh→high / max→max；
 * medium 官方未列出，按弱档处理（flash 最低档为 low）。
 */
const DEEPSEEK_FLASH_EFFORT_MAP: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'low',
  medium: 'low',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

/**
 * DeepSeek v4-pro 官方映射表（逐档映射，非通用 clamp 语义）
 *
 * 官方映射（thinking_mode 文档）：low→high / high→high / xhigh→max / max→max；
 * medium 官方未列出，按 pro 最低档处理（pro 最低映射档为 high）。
 */
const DEEPSEEK_PRO_EFFORT_MAP: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

/**
 * DeepSeek 模型思考强度映射（应用官方逐档映射表）
 *
 * @param modelId 模型 id（含 'flash' 视为 v4-flash，否则按 v4-pro 处理）
 * @param requested 请求档位
 * @returns 映射后的实际档位
 */
export function clampDeepSeekReasoningEffort(
  modelId: string,
  requested: ReasoningEffort,
): ReasoningEffort {
  const map = modelId.includes('flash') ? DEEPSEEK_FLASH_EFFORT_MAP : DEEPSEEK_PRO_EFFORT_MAP;
  return map[requested];
}
