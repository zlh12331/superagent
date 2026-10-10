// check-functions.ts：函数门禁——形参 ≤4（自研正则）+ 函数体 ≤200 行（Biome 度量），棘轮只允许收紧。
// 数据通路与 check-complexity 同款：package.json 以管道把 Biome 的 JSON 诊断喂进标准输入
// （`biome lint --only=… --reporter=json src | tsx scripts/check-functions.ts`），脚本不自起
// child_process——既避开安全扫描对子进程的拦截，也避开 shell 重定向的跨平台不可移植。
// 边界：本脚本只判定与报告，不代偿重构；阈值与分档真源在 scripts/limits.json，本文件只读取。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSourceFiles, toPosixRelative } from './lib/file-metrics';
import { scanFunctions } from './lib/function-metrics';
import {
  type BodyTier,
  type BodyTiers,
  countTiers,
  tierOf,
  validateHeavyExempt,
} from './lib/function-tiers';
import {
  evaluateRatchet,
  type Metrics,
  parseBaseline,
  proposeBaseline,
  renderProblems,
  serializeBaseline,
  wantsBaselineUpdate,
  wantsForce,
} from './lib/ratchet';

const ROOT = join(import.meta.dirname, '..');
const BASELINE_PATH = join(import.meta.dirname, 'check-functions.baseline.json');
const EXEMPT_PATH = join(import.meta.dirname, 'function-size-exempt.json');
const LIMITS_PATH = join(import.meta.dirname, 'limits.json');
const SCAN_DIRS = [join(ROOT, 'src', 'main'), join(ROOT, 'src', 'renderer')];
const RULE = 'lint/complexity/noExcessiveLinesPerFunction';
const METRICS = ['count', 'max', 'params'] as const;

/** 函数门槛 + 分档（单一真源：scripts/limits.json） */
function loadLimits(): { params: number; body: number; tiers: BodyTiers } {
  const parsed = JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as {
    functionSize?: {
      params?: number;
      body?: number;
      bodyTiers?: { mild?: number; moderate?: number; heavy?: number };
    };
  };
  return {
    params: parsed.functionSize?.params ?? 4,
    body: parsed.functionSize?.body ?? 200,
    tiers: {
      mild: parsed.functionSize?.bodyTiers?.mild ?? 400,
      moderate: parsed.functionSize?.bodyTiers?.moderate ?? 400,
      heavy: parsed.functionSize?.bodyTiers?.heavy ?? 400,
    },
  };
}
const { params: PARAM_LIMIT, body: BODY_LIMIT, tiers: BODY_TIERS } = loadLimits();

/** 读取 >heavy 档登记表（文件缺失视为空表） */
function loadExempt(): Map<string, string> {
  if (!existsSync(EXEMPT_PATH)) return new Map();
  const parsed = JSON.parse(readFileSync(EXEMPT_PATH, 'utf8')) as {
    entries?: Array<{ key?: unknown; reason?: unknown }>;
  };
  const map = new Map<string, string>();
  for (const e of parsed.entries ?? []) {
    if (typeof e.key === 'string' && typeof e.reason === 'string') {
      map.set(e.key, e.reason);
    }
  }
  return map;
}

interface BiomeDiagnostic {
  readonly category?: string;
  readonly message?: string;
  readonly location?: { readonly path?: string };
}

function readBiomeJson(): BiomeDiagnostic[] {
  let raw: string;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    console.error('[check-functions] 无法读取标准输入（应由 package.json 管道供给 Biome JSON）');
    process.exit(1);
  }
  const start = raw.indexOf('{');
  if (start === -1) {
    console.error('[check-functions] 上游未输出 JSON');
    process.exit(1);
  }
  const parsed = JSON.parse(raw.slice(start)) as { diagnostics?: BiomeDiagnostic[] };
  return parsed.diagnostics ?? [];
}

/** 从诊断消息提取实测行数：`too many lines (245). Maximum allowed is 200.` */
function linesOf(message: string | undefined): number | null {
  const m = (message ?? '').match(/lines \((\d+)\)/);
  return m === null ? null : Number(m[1]);
}

/** 从诊断消息提取上游实际生效阈值（阈值自校验用） */
function thresholdOf(message: string | undefined): number | null {
  const m = (message ?? '').match(/Maximum allowed is (\d+)/);
  return m === null ? null : Number(m[1]);
}

/**
 * Biome 诊断 → 按文件 body 指标（count / max）
 *
 * 排除测试文件（.test.* / __tests__/）——与旧 collectSourceFiles 及
 * check-complexity 的扫描口径一致。
 */
function toBodyMetrics(diagnostics: readonly BiomeDiagnostic[]): Map<string, Metrics> {
  const map = new Map<string, Metrics>();
  for (const d of diagnostics) {
    if (d.category !== RULE) continue;
    const rel = (d.location?.path ?? '').split('\\').join('/');
    if (rel === '' || rel.includes('.test.') || rel.includes('__tests__/')) continue;
    const value = linesOf(d.message);
    if (value === null) continue;
    const entry = map.get(rel) ?? { count: 0, max: 0 };
    entry['count'] = (entry['count'] ?? 0) + 1;
    entry['max'] = Math.max(entry['max'] ?? 0, value);
    map.set(rel, entry);
  }
  return map;
}

/**
 * 形参维度（自研正则）：src/main + src/renderer 全量扫描，形参 >4 记为超限。
 *
 * 返回 [按文件指标映射, 违规函数明细]（明细供报告输出）。
 */
function toParamsMetrics(): {
  map: Map<string, Metrics>;
  details: Array<{ file: string; name: string; line: number; params: number }>;
} {
  const map = new Map<string, Metrics>();
  const details: Array<{ file: string; name: string; line: number; params: number }> = [];
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(dir)) {
      const rel = toPosixRelative(ROOT, file);
      let max = 0;
      for (const fn of scanFunctions(readFileSync(file, 'utf8'))) {
        if (fn.params <= PARAM_LIMIT) continue;
        if (fn.params > max) max = fn.params;
        details.push({ file: rel, name: fn.name, line: fn.line, params: fn.params });
      }
      if (max > PARAM_LIMIT) map.set(rel, { params: max });
    }
  }
  return { map, details };
}

function loadBaseline(): Record<string, Metrics> {
  if (!existsSync(BASELINE_PATH)) return {};
  return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
}

/** 构造卡关区的体长分档标签（跳过 lo > hi 的退化区间） */
function buildTierBands(counts: Record<BodyTier, number>): Array<{ label: string }> {
  const bands: Array<{ label: string }> = [];
  const push = (lo: number, hi: number, name: string, count: number, register = false): void => {
    if (lo > hi) return;
    const range = Number.isFinite(hi) ? `${lo}–${hi}` : `>${lo - 1}`;
    bands.push({ label: `${name} ${range} 行 ${count} 处${register ? '（需登记理由）' : ''}` });
  };
  push(BODY_LIMIT + 1, BODY_TIERS.mild, '轻度', counts.mild);
  push(BODY_TIERS.mild + 1, BODY_TIERS.moderate, '中度', counts.moderate);
  push(BODY_TIERS.moderate + 1, BODY_TIERS.heavy, '重债', counts.heavy);
  push(BODY_TIERS.heavy + 1, Number.POSITIVE_INFINITY, '极重', counts.over, true);
  return bands;
}

function main(): number {
  const diagnostics = readBiomeJson();

  const actual = thresholdOf(diagnostics.find((d) => d.category === RULE)?.message);
  if (actual !== null && actual !== BODY_LIMIT) {
    console.error(
      `[check-functions] ❌ 阈值漂移：Biome 实际生效 ${actual} vs limits.json ${BODY_LIMIT}`,
    );
    return 1;
  }

  const current = toBodyMetrics(diagnostics);
  const { map: paramsMap, details: paramDetails } = toParamsMetrics();
  for (const [file, m] of paramsMap) {
    const entry = current.get(file) ?? {};
    entry['params'] = m['params'] ?? 0;
    current.set(file, entry);
  }

  const baseline = loadBaseline();

  if (wantsBaselineUpdate(process.argv.slice(2))) {
    const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
    writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
    console.log(
      `[check-functions] 基线已更新：${Object.keys(baseline).length} → ${Object.keys(next).length} 个文件（${BASELINE_PATH}）`,
    );
    return 0;
  }

  const problems = evaluateRatchet(current, baseline, METRICS);
  const bodyValues = diagnostics
    .filter((d) => d.category === RULE)
    .map((d) => ({
      file: (d.location?.path ?? '').split('\\').join('/'),
      value: linesOf(d.message),
    }))
    .filter(
      (d): d is { file: string; value: number } =>
        d.value !== null &&
        d.value > BODY_LIMIT &&
        !d.file.includes('.test.') &&
        !d.file.includes('__tests__/'),
    );

  const tiers = countTiers(
    bodyValues.map((d) => d.value),
    BODY_LIMIT,
    BODY_TIERS,
  );
  const exempt = loadExempt();
  const overEntries = [...current.entries()]
    .filter(([, m]) => tierOf(m['max'] ?? 0, BODY_LIMIT, BODY_TIERS) === 'over')
    .map(([file, m]) => ({ key: file, bodyLines: m['max'] ?? 0, file }));
  const { unregistered, stale: staleExempt } = validateHeavyExempt(
    overEntries,
    new Set(exempt.keys()),
  );

  const tierLines = [
    `  卡关区分档：${buildTierBands(tiers)
      .map((b) => b.label)
      .join(' | ')}`,
  ];

  if (problems.length === 0 && unregistered.length === 0 && staleExempt.length === 0) {
    console.log(
      `[check-functions] ✅ 通过：超限文件 ${current.size} 个（body ${bodyValues.length} 个函数 / params ${paramDetails.length} 个函数）` +
        `全部在棘轮基线内（基线 ${Object.keys(baseline).length} 个文件，只允许收紧）`,
    );
    console.log(
      `  门槛：形参 ≤${PARAM_LIMIT}（正则度量）/ 函数体 ≤${BODY_LIMIT} 行` +
        `（Biome noExcessiveLinesPerFunction：独占行数 + 含注释 + 跳过空行；测试文件不计）`,
    );
    for (const line of tierLines) console.log(line);
    const worst = [...current.entries()].sort((a, b) => (b[1]['max'] ?? 0) - (a[1]['max'] ?? 0))[0];
    if (worst !== undefined && (worst[1]['max'] ?? 0) > BODY_LIMIT) {
      console.log(
        `  距规范目标：最长 ${worst[1]['max']} 行（${worst[0]}）——基线只保证不劣化，不代偿重构`,
      );
    }
    console.log('  body 超限 Top 10（按文件最高值，供重构排期）：');
    for (const [file, m] of [...current.entries()]
      .filter(([, m]) => (m['max'] ?? 0) > BODY_LIMIT)
      .sort((a, b) => (b[1]['max'] ?? 0) - (a[1]['max'] ?? 0))
      .slice(0, 10)) {
      console.log(`    ${String(m['max'] ?? 0).padStart(4)} 行  count=${m['count'] ?? 0}  ${file}`);
    }
    return 0;
  }

  console.error(
    `[check-functions] ❌ 棘轮违规 ${problems.length} 处（门槛：形参 ≤${PARAM_LIMIT} / 体 ≤${BODY_LIMIT} 行）：`,
  );
  for (const line of renderProblems(problems)) console.error(line);
  if (paramDetails.length > 0) {
    console.error('  形参超限明细：');
    for (const v of paramDetails.sort((a, b) => b.params - a.params).slice(0, 20)) {
      console.error(`  ${v.file}:${v.line} ${v.name}() params=${v.params}`);
    }
  }
  console.error(
    '[check-functions] 修复指引：拆分函数/提取 hook；已重构请跑 pnpm check:functions --update-baseline',
  );
  return 1;
}

process.exitCode = main();
