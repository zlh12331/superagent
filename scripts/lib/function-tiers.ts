/** 体长分档阈值 */
export interface BodyTiers {
  /** 轻度档上界（如 100） */
  readonly mild: number;
  /** 中度档上界（如 200） */
  readonly moderate: number;
  /** 重债档上界（如 400） */
  readonly heavy: number;
}

/** 分档名；null = 未超规范门槛（不入档） */
export type BodyTier = 'mild' | 'moderate' | 'heavy' | 'over';

/**
 * 按净行数归类体长分档
 *
 * @param bodyLines 函数体净行数
 * @param limit 规范门槛（如 40）——≤ limit 不入档
 * @param tiers 分档阈值
 * @returns 分档名；未超门槛返回 null
 */
export function tierOf(bodyLines: number, limit: number, tiers: BodyTiers): BodyTier | null {
  if (bodyLines <= limit) return null;
  if (bodyLines <= tiers.mild) return 'mild';
  if (bodyLines <= tiers.moderate) return 'moderate';
  if (bodyLines <= tiers.heavy) return 'heavy';
  return 'over';
}

/** 统计各档条目数（供门禁输出） */
export function countTiers(
  bodyLinesList: readonly number[],
  limit: number,
  tiers: BodyTiers,
): Record<BodyTier, number> {
  const out: Record<BodyTier, number> = { mild: 0, moderate: 0, heavy: 0, over: 0 };
  for (const body of bodyLinesList) {
    const t = tierOf(body, limit, tiers);
    if (t !== null) out[t] += 1;
  }
  return out;
}

/**
 * 校验 >400 档登记表（未登记 / 陈旧登记）
 *
 * @param overEntries 当前 >400 档的条目（key + bodyLines）
 * @param exemptKeys 登记表中的 key 集合
 * @returns 未登记条目 + 陈旧登记 key
 */
export function validateHeavyExempt(
  overEntries: readonly { readonly key: string; readonly bodyLines: number }[],
  exemptKeys: ReadonlySet<string>,
): { unregistered: typeof overEntries; stale: string[] } {
  const unregistered = overEntries.filter((e) => !exemptKeys.has(e.key));
  const overKeys = new Set(overEntries.map((e) => e.key));
  const stale = [...exemptKeys].filter((k) => !overKeys.has(k));
  return { unregistered, stale };
}
