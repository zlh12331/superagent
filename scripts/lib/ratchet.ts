// scripts/lib/ratchet.ts
// 棘轮基线（ratchet baseline）公共工具：让「存量违规」可审计且只能收紧
// ──────────────────────────────────────────────────────────────
// 背景：静态门禁若直接卡死阈值，会把存量违规误报为新问题；若改用豁免清单
// （Set<string>），清单会与代码漂移——记录的行数过期、文件重构后清单条目
// 仍留在原地（check-file-size 曾出现此症状）。
//
// 本模块把「存量违规」外置为 JSON 基线文件，并强制单向收紧：
//   1. 基线外的新违规      → 失败（不允许悄悄加豁免）
//   2. 基线内指标变大      → 失败（棘轮：只能更小）
//   3. 基线内条目已不再违规 → 失败（陈旧豁免必须清理，跑 --update-baseline 收紧）
//   4. --update-baseline   → 只在 --force 时允许写高数值
//
// 约定：基线 key 为文件相对路径（体积类）或 `路径#符号名`（函数类），
// 值为「指标名 → 实测值」映射；指标名由调用方声明（metrics）。
// ──────────────────────────────────────────────────────────────

/** 单条基线/实测记录：指标名 → 数值（行数、体积 KiB 等） */
export type Metrics = Record<string, number>;

/** 基线文件结构：key → 指标 */
export type Baseline = Record<string, Metrics>;

/** 一条棘轮问题（新增违规 / 变大 / 已消解未清理） */
export interface RatchetProblem {
  readonly kind: 'new' | 'grown' | 'stale';
  readonly key: string;
  readonly detail: string;
}

/**
 * 读取基线 JSON；文件缺失或结构非法时抛错（门禁宁可显式失败也不静默放行）
 *
 * 2026-09-08 语义调整（棘轮只锁「超限」维度）：
 * - `metrics` 从「必须全部存在」改为「允许出现的指标集」——某函数 params 合规、
 *   仅 body 超限时，条目不记 params。缺失指标视为「该维度未超限」。
 * - 未知字段由「静默丢弃」改为报错：防止基线里塞入无人校验的字段（此前
 *   `{"net":100,"extra":999}` 会静默丢 extra）。
 *
 * @param raw 基线文件原始内容
 * @param metrics 允许出现的指标名集合
 * @returns 解析后的基线映射（每条至少含一个指标）
 */
export function parseBaseline(raw: string, metrics: readonly string[]): Baseline {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('基线文件格式错误：顶层必须是对象');
  }
  const out: Baseline = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`基线条目 ${key} 格式错误：必须是指标对象`);
    }
    const entry = value as Record<string, unknown>;
    const metrics_: Metrics = {};
    for (const [m, v] of Object.entries(entry)) {
      if (!metrics.includes(m)) {
        throw new Error(`基线条目 ${key} 含未知指标 ${m}（允许：${metrics.join('/')}）`);
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`基线条目 ${key} 的 ${m} 必须是数值，当前为 ${JSON.stringify(v)}`);
      }
      metrics_[m] = v;
    }
    if (Object.keys(metrics_).length === 0) {
      throw new Error(`基线条目 ${key} 不含任何指标`);
    }
    out[key] = metrics_;
  }
  return out;
}

/** 序列化基线（按 key 与指标名排序，保证 diff 稳定可读） */
export function serializeBaseline(baseline: Baseline): string {
  const sorted: Baseline = {};
  for (const key of Object.keys(baseline).sort()) {
    const entry = baseline[key];
    if (entry === undefined) continue;
    const ordered: Metrics = {};
    for (const m of Object.keys(entry).sort()) ordered[m] = entry[m];
    sorted[key] = ordered;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * 棘轮比对：实测违规集 vs 基线
 *
 * @param current 实测违规（key → 指标）；只包含**超限**的条目与**超限**的指标
 * @param baseline 已提交基线
 * @param metrics 参与比对的指标名集合
 * @returns 问题列表（空数组表示门禁通过）
 *
 * 2026-09-08 修正（棘轮只锁超限维度）：此前比对 `metrics` 里的全部指标，
 * 于是「params 超限、body 合规」的函数，其 body 从 30 涨到 39（仍未超限）
 * 也会报 grown——把棘轮从「超限维度不得劣化」扩大成「该函数所有维度永久
 * 锁死」。现改为只比对**基线中记录的**指标：基线只记超限维度，故合规维度
 * 上涨不再卡关（由门槛本身约束）。
 */
export function evaluateRatchet(
  current: ReadonlyMap<string, Metrics>,
  baseline: Baseline,
  metrics: readonly string[],
): RatchetProblem[] {
  const problems: RatchetProblem[] = [];

  for (const [key, cur] of current) {
    const base = baseline[key];
    if (base === undefined) {
      problems.push({
        kind: 'new',
        key,
        detail: `新增超限（基线外）：${formatMetrics(cur, metrics)}——请重构，或经评审后跑 --update-baseline`,
      });
      continue;
    }
    // 只比对基线记录的指标（= 上次超限的维度）
    const tracked = Object.keys(base);
    const grown = tracked.filter((m) => (cur[m] ?? 0) > (base[m] ?? 0));
    if (grown.length > 0) {
      problems.push({
        kind: 'grown',
        key,
        detail: `棘轮劣化 ${grown.map((m) => `${m} ${base[m] ?? 0}→${cur[m] ?? 0}`).join(', ')}（基线值只允许下降）`,
      });
    }
  }

  for (const key of Object.keys(baseline)) {
    if (!current.has(key)) {
      const base = baseline[key];
      problems.push({
        kind: 'stale',
        key,
        detail: `基线条目已不再超限（${formatMetrics(base ?? {}, metrics)}）——跑 --update-baseline 收紧基线`,
      });
    }
  }

  return problems;
}

/**
 * 计算收紧后的基线：仅保留当前仍超限的条目与**超限的指标**，
 * 数值取 min(旧值, 实测值)；高于旧值的新实测（劣化）不写入——除非 force=true。
 *
 * 2026-09-08：改为只遍历 `cur` 实际记录的指标（= 超限维度）。此前遍历全部
 * metrics 并把缺失指标补 0，会把「合规维度」也写进基线（例如 body 未超限
 * 却记 body:0），既污染基线又让后续判定语义混乱。
 */
export function proposeBaseline(
  current: ReadonlyMap<string, Metrics>,
  baseline: Baseline,
  metrics: readonly string[],
  force = false,
): Baseline {
  const out: Baseline = {};
  for (const [key, cur] of current) {
    const base = baseline[key];
    const merged: Metrics = {};
    for (const [m, c] of Object.entries(cur)) {
      if (!metrics.includes(m)) continue;
      const b = base?.[m];
      merged[m] = b === undefined || force || c <= b ? c : b;
    }
    if (Object.keys(merged).length > 0) out[key] = merged;
  }
  return out;
}

/** 指标映射转可读串（用于日志） */
export function formatMetrics(metrics: Metrics, keys: readonly string[]): string {
  return keys.map((k) => `${k} ${metrics[k] ?? 0}`).join(' / ');
}

/** 是否请求了基线更新 */
export function wantsBaselineUpdate(argv: readonly string[]): boolean {
  return argv.includes('--update-baseline');
}

/** 是否请求了强制（允许写高基线值） */
export function wantsForce(argv: readonly string[]): boolean {
  return argv.includes('--force');
}

/**
 * 渲染棘轮问题输出（按 kind 分组，控制条数避免刷屏）
 *
 * @param problems 问题列表
 * @param limit 单类最多输出条数
 * @returns 每行一条（不含换行符）
 */
export function renderProblems(problems: readonly RatchetProblem[], limit = 25): string[] {
  const lines: string[] = [];
  for (const kind of ['grown', 'new', 'stale'] as const) {
    const group = problems.filter((p) => p.kind === kind);
    if (group.length === 0) continue;
    const label = kind === 'grown' ? '劣化' : kind === 'new' ? '新增超限' : '陈旧基线条目';
    lines.push(`— ${label} ${group.length} 处：`);
    for (const p of group.slice(0, limit)) lines.push(`  [${kind}] ${p.key}：${p.detail}`);
    if (group.length > limit) lines.push(`  … 其余 ${group.length - limit} 处省略`);
  }
  return lines;
}
