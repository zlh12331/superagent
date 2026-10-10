// reasoning-effort.ts：推理力度档位——五档枚举 + 档位秩（clamp/比较用）+ 别名归一
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_TIERS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

// 档位秩：数值供 clamp 越界回退与跨档比较（间隔刻意不均匀——xhigh/max 是深思考专区）
export const REASONING_EFFORT_RANKS: Record<ReasoningEffort, number> = {
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70,
};

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
  const stronger = ranked.find((tier) => REASONING_EFFORT_RANKS[tier] >= requestedRank);
  if (stronger !== undefined) {
    return stronger;
  }
  return ranked[ranked.length - 1] ?? requested;
}

const DEEPSEEK_FLASH_EFFORT_MAP: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'low',
  medium: 'low',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

const DEEPSEEK_PRO_EFFORT_MAP: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

export function clampDeepSeekReasoningEffort(
  modelId: string,
  requested: ReasoningEffort,
): ReasoningEffort {
  const map = modelId.includes('flash') ? DEEPSEEK_FLASH_EFFORT_MAP : DEEPSEEK_PRO_EFFORT_MAP;
  return map[requested];
}
