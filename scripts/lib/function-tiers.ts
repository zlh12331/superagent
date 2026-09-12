// scripts/lib/function-tiers.ts
// 函数体净行分档纯函数（2026-09-08 引入；2026-09-11 随门槛上移为 200/400/400）
// ──────────────────────────────────────────────────────────────
// 为什么分档：check-functions 的超限条目里大量是轻度超标、仅极少数巨大——
// 混在一个数字里看不出重构优先级。分档让「债的严重度」可见，
// 并让超过 heavy 档者必须显式登记理由（避免「暂时容忍」静默变成「永久合法」）。
//
// 设计边界（重要）：
// - 分档**只影响输出分级与 heavy 档的登记校验**，不改变棘轮判定
// - 阈值真源 scripts/limits.json 的 functionSize.bodyTiers（禁止在此硬编码）
// - 为什么不用「该不该拆」做判定：那取决于函数内部结构（声明平铺 vs 控制流
//   嵌套），按行数的静态度量判不出来。**该判断已由 check:complexity 承担**
//   （认知复杂度按嵌套加权，能区分「JSX 平铺」与「分支纠缠」）；本分档只按净行数
//   分级，理由是否成立由登记表人工把关。
// ──────────────────────────────────────────────────────────────

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
