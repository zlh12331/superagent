// scripts/check-functions.ts
// 函数门禁（工程化强制）：形参数 ≤4（自研正则度量）+ 函数体 ≤200 行（Biome 度量），棘轮只允许收紧
// ──────────────────────────────────────────────────────────────
// 2026-09-15 体长度量迁移（用户拍板）：函数体行数改由 Biome 内置规则
// noExcessiveLinesPerFunction（v2.0.0 起，lint/complexity 组）度量，自研正则
// 花括号扫描（function-metrics.ts 的 measureBodyLines 族）退役。理由与
// check:complexity 同款：度量语义必须权威且唯一，与其维护第二套解析器并承担
// 漂移风险，不如复用 Biome（先例：认知复杂度自研两版皆败，迁移后问题消失）。
// 自研版头注释登记的全部「已知边界」（对象字面量返回类型 / 多层嵌套形参括号 /
// 嵌套模板串的漏报）随迁移消失。
//
// 口径变化（重要——基线已按新口径重算，跨口径比较行数无意义）：
// - 旧（自研正则）：净行（排除注释与空行），嵌套函数体计入外层
// - 新（Biome）：独占行数（嵌套函数体单独计量，不计入外层）+ 含注释行 +
//   skipBlankLines（跳过空行）。同函数实测普遍低于旧口径
//   （createMockApi 488→380、ChatInput 303→207），阈值 200 不变
// - 测试文件（.test.* / __tests__/）不计——与旧 collectSourceFiles 及
//   check-complexity 的扫描口径一致（测试的长 setup 不是重构信号）
//
// params 仍用自研正则（Biome 无形参个数规则）：解构按 1 计，见 function-metrics.ts。
//
// 数据通路（与 check-complexity 同款）：package.json 以管道串联——
// `biome lint --only=... --reporter=json src | tsx scripts/check-functions.ts`；
// 脚本从标准输入读 JSON，避免 child_process（安全扫描拦截 + shell 重定向不可移植）。
// 阈值自校验：诊断消息含上游实际生效阈值，与 limits.json functionSize.body 比对，
// 不一致即失败——防止 Biome 升级改默认值或有人本地改配置而门禁静默失真。
//
// 基线口径（按文件，与 check-complexity 同款折中——Biome 诊断不含函数名，行号 key
// 会随上方增删漂移）：
//   body 维度   count = 该文件超阈值函数数；max = 该文件最高行数
//   params 维度 params = 该文件最高形参数（正则可定位函数，但统一文件级 key 降复杂度）
//
// 提示档（51–200 仅提示）随迁移移除：其「值得被看见」职责已由 check:complexity
// 接管——它对全部函数计量控制流复杂度，不再依赖行数做代理。
//
// 运行：pnpm check:functions
//       pnpm check:functions --update-baseline   # 重构后收紧基线
// ──────────────────────────────────────────────────────────────

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
  // 文件缺失 → 空基线（首次 --update-baseline 得以创建；普通运行把所有超限报成 new）
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

  // 阈值自校验：诊断消息里的上游阈值必须与 limits.json 真源一致
  const actual = thresholdOf(diagnostics.find((d) => d.category === RULE)?.message);
  if (actual !== null && actual !== BODY_LIMIT) {
    console.error(
      `[check-functions] ❌ 阈值漂移：Biome 实际生效 ${actual} vs limits.json ${BODY_LIMIT}`,
    );
    return 1;
  }

  // body（Biome）+ params（正则）两维度合并为按文件的棘轮实测集
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
  // 分档按「每个函数」的实测值计数（不是每文件 max——同文件多个超限函数各占一档）；
  // 测试文件不计（与 toBodyMetrics / 旧 collectSourceFiles 口径一致）
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

  // 体长分档统计（按函数诊断值；2026-09-08 引入：让重构优先级可见）
  const tiers = countTiers(
    bodyValues.map((d) => d.value),
    BODY_LIMIT,
    BODY_TIERS,
  );
  // >heavy 档必须登记理由（登记表 scripts/function-size-exempt.json）
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
    // 「距规范目标的差距」：避免棘轮把「暂时容忍」静默变成「永久合法」
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
