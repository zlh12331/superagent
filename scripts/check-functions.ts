// scripts/check-functions.ts
// 函数门禁（工程化强制）：形参数 ≤4 + 函数体 ≤200 净行，双指标棘轮 + 体长分档 + 提示档
// ──────────────────────────────────────────────────────────────
// 依据 typescript-dev-standards-ai.md §函数（参数≤4 对象封装 / 函数体≤40 行）
// 与业界实践（eslint max-params 3-4、max-lines-per-function 常见 50）。
//
// 2026-09-11 门槛调整（用户拍板）：body 50 → 100，并新增 bodyNotice=50 提示线。
// 「≤50 不进提示、51–100 仅提示不卡关、>100 进棘轮基线」。理由见 scripts/limits.json
// 的 $comment3（50 是 eslint 默认值、不适用 JSX；106 条基线里 59 条落 51–100 且
// 多为结构性长，误报过半导致整条门禁被习惯性忽略）。
// 阈值真源 scripts/limits.json functionSize（禁止在此硬编码）。
//
// 2026-09-15 门槛调整（用户拍板）：body 100 → 200，bodyNotice 50 → 100，tiers 上移
// 一档（mild 400）。理由见 scripts/limits.json 的 $comment5：复杂度门禁（≤15，Biome
// 内置规则、度量可靠）升为唯一细粒度语义门禁，行数退位为「防怪兽」粗网——双硬门槛
// 会互相拆台（降复杂度的提函数/卫语句天然增行数，实测 history-parts 修复杂度后文件
// 反而变长），且行数度量（自研正则、已知漂移）弱于复杂度度量，细粒度卡关不应压在
// 最弱的度量上。登记线 400 不动（绝对判断不随超限门槛移动）。
//
// 2026-08-30 审计修复（原实现三处静默失效）：
//   1. 原「函数体 ≤40 行依赖 AST，由 TypeDoc/代码评审兜底」= 从未度量。
//      现以花括号深度扫描度量（lib/function-metrics.ts；该模块当前仍为正则实现，
//      属「待评估迁移 AST」状态——见其头注释与技术选型原则）。
//   2. 原「解构对象参数 → 整函数 return null 跳过」= 最常见的 React 组件
//      （props 解构）与对象封装写法全部逃逸参数统计。现解构按 1 个形参计数。
//   3. 原 `const f = x => {}` 裸标识符单参箭头完全不匹配 → 现按 1 参 + 度量体长。
//   4. 原豁免只有一处手写 Set；现存量违规外置棘轮基线（只能收紧）。
//
// 2026-09-08 体长分档（用户拍板 100/200/400；2026-09-11 随门槛上移为 200/400/400）：
//   轻度 / 中度 / 极重（>400 必须登记理由）。分档只影响输出分级与 >400 档的登记校验，
//   不改变棘轮判定。为什么分档：超限里大量是「结构性长」而非控制流嵌套（IPC handler
//   工厂、React JSX 树），混在一个数字里看不出重构优先级。
//
// 已知边界（漏报方向，不误报）：返回类型含对象字面量类型的函数可能漏配。
// 故基线数字是**下界**，不可当上限解读。
//
// 运行：pnpm check:functions
//       pnpm check:functions --update-baseline   # 重构后收紧基线
// ──────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSourceFiles, toPosixRelative } from './lib/file-metrics';
import { type FnMetric, scanFunctions } from './lib/function-metrics';
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

/** 函数门槛 + 分档（单一真源：scripts/limits.json） */
function loadLimits(): { params: number; body: number; notice: number; tiers: BodyTiers } {
  const parsed = JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as {
    functionSize?: {
      params?: number;
      body?: number;
      bodyNotice?: number;
      bodyTiers?: { mild?: number; moderate?: number; heavy?: number };
    };
  };
  return {
    params: parsed.functionSize?.params ?? 4,
    body: parsed.functionSize?.body ?? 40,
    notice: parsed.functionSize?.bodyNotice ?? 40,
    tiers: {
      mild: parsed.functionSize?.bodyTiers?.mild ?? 100,
      moderate: parsed.functionSize?.bodyTiers?.moderate ?? 200,
      heavy: parsed.functionSize?.bodyTiers?.heavy ?? 400,
    },
  };
}
const {
  params: PARAM_LIMIT,
  body: BODY_LIMIT,
  notice: BODY_NOTICE,
  tiers: BODY_TIERS,
} = loadLimits();
const METRICS = ['params', 'body'] as const;

/**
 * 读取 >400 档登记表（文件缺失视为空表）
 *
 * @returns key → 登记理由
 */
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

/**
 * 一处超限（key = `相对路径#函数名`，行号不入 key 以免代码上方插入注释即漂移）
 *
 * key 稳定性评估（2026-09-08，实测后决定保持现状）：
 * 同名函数用 `#2`/`#3` 序号区分。理论缺陷是「在文件中间插入一个同名函数」
 * 会让原有条目的序号位移（语义漂移）；但实测两种替代方案都更差：
 * - 行号 key（`name@行`）：任何上方增删行都漂移——本项目改代码时几乎每次都动行号
 * - 内容哈希 key：同名函数体相同即冲突，且改动函数体就换 key
 * 且当前基线 143 条中带序号的条目为 **0 条**（同名函数同时超限的场景未出现），
 * 该风险在实践中未发生。故保持序号方案，不在无收益的情况下引入新漂移源。
 */
interface Violation extends FnMetric {
  readonly file: string;
  readonly key: string;
}

/** 单次全量扫描结果（避免同一文件被重复解析） */
interface ScanResult {
  readonly all: Array<FnMetric & { file: string }>;
  readonly violations: Violation[];
}

function collectFiles(): string[] {
  // 与 check-file-size 保持同一收集口径；mock-api.ts 这类「运行时开发模拟层」
  // 同样受函数门禁约束（原实现整体排除），排除只会让长函数藏在不被看的文件里。
  return SCAN_DIRS.flatMap((d) => collectSourceFiles(d));
}

/** 全量扫描：一次读文件，产出全部函数度量 + 超限集 */
function scanAll(): ScanResult {
  const all: Array<FnMetric & { file: string }> = [];
  const violations: Violation[] = [];
  for (const file of collectFiles()) {
    const rel = toPosixRelative(ROOT, file);
    const seen = new Map<string, number>();
    for (const fn of scanFunctions(readFileSync(file, 'utf8'))) {
      all.push({ ...fn, file: rel });
      const times = (seen.get(fn.name) ?? 0) + 1;
      seen.set(fn.name, times);
      if (fn.params <= PARAM_LIMIT && fn.bodyLines <= BODY_LIMIT) continue;
      violations.push({
        ...fn,
        file: rel,
        key: times === 1 ? `${rel}#${fn.name}` : `${rel}#${fn.name}#${times}`,
      });
    }
  }
  return { all, violations };
}

/**
 * 超限集 → 指标映射（2026-09-08：只记**超限**的指标）
 *
 * 此前记录全部指标值，导致「params 超限、body 合规」的函数其 body 也被
 * 永久锁死（body 从 30 涨到 39 仍未超限却报 grown）。现只记超限维度，
 * 与 ratchet.ts 的「棘轮只锁超限维度」语义一致。
 */
function toMetricMap(violations: readonly Violation[]): Map<string, Metrics> {
  const map = new Map<string, Metrics>();
  for (const v of violations) {
    const entry: Metrics = {};
    if (v.params > PARAM_LIMIT) entry['params'] = v.params;
    if (v.bodyLines > BODY_LIMIT) entry['body'] = v.bodyLines;
    map.set(v.key, entry);
  }
  return map;
}

function loadBaseline(): Record<string, Metrics> {
  // 文件缺失 → 空基线（首次 --update-baseline 得以创建；普通运行把所有超限报成 new）
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-functions] ❌ 基线读取失败（${BASELINE_PATH}）：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/**
 * 构造卡关区的体长分档标签（跳过退化区间）
 *
 * 为什么动态构造：门槛抬到 100 后 tiers 上移一档（mild 200 / moderate 400），而登记
 * 阈值刻意保持 >400（heavy 与 moderate 同值）——此时「重债 moderate+1–heavy」是
 * 401–400 的退化区间，静态字符串拼接会打印出毫无意义的「重债 401–400 行 0 处」。
 * 故按边界动态构造，并跳过 lo > hi 的空档。
 *
 * @param counts countTiers 的统计结果（各档条目数）
 * @returns 各档标签（跳过退化区间）
 */
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
  const { all, violations } = scanAll();
  const current = toMetricMap(violations);
  const baseline = loadBaseline();
  const longest = all.filter((f) => f.bodyLines > 0).sort((a, b) => b.bodyLines - a.bodyLines);

  if (wantsBaselineUpdate(process.argv.slice(2))) {
    const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
    writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
    console.log(
      `[check-functions] 基线已更新：${Object.keys(baseline).length} → ${Object.keys(next).length} 条（${BASELINE_PATH}）`,
    );
    return 0;
  }

  const problems = evaluateRatchet(current, baseline, METRICS);
  const paramHits = violations.filter((v) => v.params > PARAM_LIMIT).length;
  const bodyHits = violations.filter((v) => v.bodyLines > BODY_LIMIT).length;

  // 体长分档统计（2026-09-08：让重构优先级可见）
  const overBody = violations.filter((v) => v.bodyLines > BODY_LIMIT);
  const tiers = countTiers(
    overBody.map((v) => v.bodyLines),
    BODY_LIMIT,
    BODY_TIERS,
  );
  // >400 档必须登记理由（登记表 scripts/function-size-exempt.json）
  const exempt = loadExempt();
  const overEntries = overBody
    .filter((v) => tierOf(v.bodyLines, BODY_LIMIT, BODY_TIERS) === 'over')
    .map((v) => ({ key: v.key, bodyLines: v.bodyLines, file: v.file, line: v.line, name: v.name }));
  const { unregistered, stale: staleExempt } = validateHeavyExempt(
    overEntries,
    new Set(exempt.keys()),
  );

  const tierLines = [
    `  卡关区分档：${buildTierBands(tiers)
      .map((b) => b.label)
      .join(' | ')}`,
  ];

  // 提示档（2026-09-11）：bodyNotice+1 – body 净行——**仅提示，不卡关、不入基线**。
  // 为什么需要它：门槛从 50 抬到 100 后，若不单列这一区间，「51–100 完全失明」——
  // 其中确有真逻辑密集的函数（如 ipc-agent-transport#sendMessages 96 行、
  // search-service#grep 94 行），它们不是「声明平铺」而是控制流密集，值得继续被看见。
  // 样本见下方「最长函数体 Top 10」（该输出含未超限项，天然覆盖本区间）。
  const noticeBody = all.filter((f) => f.bodyLines > BODY_NOTICE && f.bodyLines <= BODY_LIMIT);
  if (noticeBody.length > 0) {
    tierLines.push(
      `  提示档（${BODY_NOTICE + 1}–${BODY_LIMIT} 净行，仅提示不卡关）：${noticeBody.length} 处`,
    );
  }

  if (problems.length === 0 && unregistered.length === 0 && staleExempt.length === 0) {
    console.log(
      `[check-functions] ✅ 通过：${all.length} 个函数签名（体长可测 ${longest.length} 个），` +
        `${violations.length} 处超限（形参 ${paramHits} / 体长 ${bodyHits}）全部在棘轮基线内` +
        `（基线 ${Object.keys(baseline).length} 条，只允许收紧）`,
    );
    console.log(
      `  门槛：形参 ≤${PARAM_LIMIT} / 函数体 ≤${BODY_LIMIT} 净行（净行 = 排除空行与纯注释，与 check-file-size 同口径）`,
    );
    for (const line of tierLines) console.log(line);
    // 像 check-coverage-floors 一样打印「距规范目标的差距」，避免棘轮把
    // 「暂时容忍」静默变成「永久合法」——基线里的条目是债，不是成就
    const worst = [...overBody].sort((a, b) => b.bodyLines - a.bodyLines)[0];
    if (worst !== undefined) {
      const over = worst.bodyLines - BODY_LIMIT;
      console.log(
        `  距规范目标：${overBody.length} 个函数体超 ${BODY_LIMIT} 净行，最长 ${worst.bodyLines} 净行` +
          `（超 ${over} 行，${worst.file}）——基线只保证不劣化，不代偿重构`,
      );
    }
    console.log('  最长函数体 Top 10（含未超限项，供重构排期）：');
    for (const r of longest.slice(0, 10)) {
      console.log(`    ${r.bodyLines} 行  ${r.file}:${r.line} ${r.name}()`);
    }
    return 0;
  }

  if (problems.length === 0) {
    // 棘轮通过但分档校验未过
    console.error('[check-functions] ❌ 体长分档校验失败：');
    for (const line of tierLines) console.error(line);
    for (const v of unregistered) {
      console.error(
        `  [未登记] ${v.file}:${v.line} ${v.name}() body=${v.bodyLines} 净行` +
          `（>${BODY_TIERS.heavy}，请在 scripts/function-size-exempt.json 登记理由）`,
      );
    }
    for (const key of staleExempt) {
      console.error(`  [陈旧登记] ${key} 已不再 >${BODY_TIERS.heavy} 行——请从登记表删除`);
    }
    console.error(
      '[check-functions] 修复指引：拆分函数，或在 scripts/function-size-exempt.json 写明为何不可拆（结构性长：声明平铺/JSX 树等）',
    );
    return 1;
  }

  console.error(
    `[check-functions] ❌ ${problems.length} 处棘轮违规（门槛：形参 ≤${PARAM_LIMIT} / 体 ≤${BODY_LIMIT} 行）：`,
  );
  for (const line of renderProblems(problems)) console.error(line);
  console.error(`[check-functions] 当前全部超限 ${violations.length} 处（按体长降序）：`);
  for (const v of [...violations].sort((a, b) => b.bodyLines - a.bodyLines).slice(0, 30)) {
    console.error(
      `  ${v.file}:${v.line} ${v.name}() params=${v.params} body=${v.bodyLines}${v.destructured ? ' (解构首参)' : ''}`,
    );
  }
  if (violations.length > 30) console.error(`  … 其余 ${violations.length - 30} 处省略`);
  console.error(
    '[check-functions] 修复指引：拆分函数/提取 hook；已重构请跑 pnpm check:functions --update-baseline',
  );
  return 1;
}

process.exitCode = main();
