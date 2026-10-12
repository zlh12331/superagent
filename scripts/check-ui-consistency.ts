// scripts/check-ui-consistency.ts
// 渲染层写法一致性门禁（2026-09 一致性审计收敛项）：标准设施（unwrap/confirm store/
// useCopy/AsyncSection）建成后，用静态信号阻止「离群写法回潮」——直接 IPC、手写
// 解包、裸 button、try/finally bail-out 等十一条规则（判据核在 scripts/lib/ui-consistency-rules.ts）
// 双向棘轮：违规基线管下限（只许下降），设施采用率基线管上限（推标准设施落地，
// 当前 < 历史最高 = 设施被拆除，卡关）
// 运行：pnpm check:ui-consistency [--update-baseline | --update-adoption]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { scanUiConsistency, UI_RULES, type UiViolation } from './lib/ui-consistency-rules';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src', 'renderer');
const BASELINE_PATH = join(import.meta.dirname, 'ui-consistency-baseline.json');
/**
 * 棘轮指标名（2026-09-08 收敛到 lib/ratchet.ts）
 *
 * 本门禁的「违规」是每条规则的命中计数，故 key = 规则 id、指标 = count。
 */
const METRICS = ['count'] as const;

const ADOPTION_BASELINE_PATH = join(import.meta.dirname, 'ui-consistency-adoption-baseline.json');

const ADOPTION_FACILITIES = [
  { id: 'useCopy', match: 'hooks/use-copy' },
  { id: 'AsyncBoundary', match: 'components/common/AsyncBoundary' },
  { id: 'SectionErrorBoundary', match: 'components/common/SectionErrorBoundary' },
  { id: 'DialogHost', match: 'components/common/DialogHost' },
] as const;

function collectFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'coverage') continue;
      collectFiles(full, out);
    } else if ((name.endsWith('.tsx') || name.endsWith('.ts')) && !name.includes('.test.')) {
      out.push(full);
    }
  }
}

const files: string[] = [];
collectFiles(SRC, files);

const violations: UiViolation[] = scanUiConsistency(
  files.map((full) => ({
    relFile: relative(SRC, full).split('\\').join('/'),
    lines: readFileSync(full, 'utf8').split('\n'),
  })),
);

const counts: Record<string, number> = {};
for (const v of violations) {
  counts[v.rule] = (counts[v.rule] ?? 0) + 1;
}
const current = new Map<string, Metrics>();
for (const [ruleId, count] of Object.entries(counts)) {
  if (count > 0) current.set(ruleId, { count });
}

function loadBaseline(): Record<string, Metrics> {
  if (!existsSync(BASELINE_PATH)) {
    console.error('[check-ui-consistency] ❌ 缺少基线文件 scripts/ui-consistency-baseline.json');
    process.exit(1);
  }
  try {
    return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-ui-consistency] ❌ 基线读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

const baseline = loadBaseline();

const adoptionCurrent = new Map<string, number>();
for (const { id, match } of ADOPTION_FACILITIES) {
  let n = 0;
  for (const full of files) {
    if (readFileSync(full, 'utf8').includes(match)) n += 1;
  }
  adoptionCurrent.set(id, n);
}

function loadAdoptionBaseline(): Record<string, Metrics> {
  if (!existsSync(ADOPTION_BASELINE_PATH)) return {};
  try {
    return parseBaseline(readFileSync(ADOPTION_BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-ui-consistency] ❌ 采用率基线读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

const adoptionBaseline = loadAdoptionBaseline();

if (process.argv.slice(2).includes('--update-adoption')) {
  const next: Record<string, Metrics> = { ...adoptionBaseline };
  for (const { id } of ADOPTION_FACILITIES) {
    const cur = adoptionCurrent.get(id) ?? 0;
    const old = next[id]?.['count'] ?? 0;
    next[id] = { count: Math.max(old, cur) };
  }
  writeFileSync(ADOPTION_BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(
    `[check-ui-consistency] 采用率基线已更新（${ADOPTION_BASELINE_PATH}，逐设施取 max(旧, 实测)）：`,
  );
  for (const { id } of ADOPTION_FACILITIES) {
    console.log(`  ${id}: ${next[id]?.['count'] ?? 0}`);
  }
  process.exit(0);
}

if (wantsBaselineUpdate(process.argv.slice(2))) {
  const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
  writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
  console.log(
    `[check-ui-consistency] 基线已更新：${Object.keys(baseline).length} → ${Object.keys(next).length} 条`,
  );
  process.exit(0);
}

const problems = evaluateRatchet(current, baseline, METRICS);
if (problems.length > 0) {
  console.error(`[check-ui-consistency] ❌ 一致性棘轮违规 ${problems.length} 处：`);
  for (const line of renderProblems(problems)) console.error(line);
  for (const rule of UI_RULES) console.error(`  规则 ${rule.id}：${rule.desc}`);
  console.error(
    '[check-ui-consistency] 修复指引：AGENTS.md「渲染层写法标准」；已收敛请跑 --update-baseline 收紧基线',
  );
  process.exit(1);
}

const adoptionProblems: string[] = [];
for (const { id } of ADOPTION_FACILITIES) {
  const cur = adoptionCurrent.get(id) ?? 0;
  const base = adoptionBaseline[id]?.['count'] ?? 0;
  if (cur < base) {
    adoptionProblems.push(
      `  [adoption] ${id}：引用文件 ${cur} 低于基线 ${base}（设施被拆除或降级）`,
    );
  }
}
if (adoptionProblems.length > 0) {
  console.error('[check-ui-consistency] ❌ 设施采用率棘轮违规：');
  for (const line of adoptionProblems) console.error(line);
  console.error(
    '[check-ui-consistency] 修复指引：恢复设施引用；确属设计变更请 --update-adoption 并说明理由',
  );
  process.exit(1);
}

console.log(
  `[check-ui-consistency] ✅ 通过：${files.length} 个文件，${violations.length} 处命中（均在棘轮基线内）`,
);
for (const v of violations) {
  console.log(`  [${v.rule}] ${v.file}:${v.line}`);
}
const adoptionLine = ADOPTION_FACILITIES.map(({ id }) => {
  const cur = adoptionCurrent.get(id) ?? 0;
  const base = adoptionBaseline[id]?.['count'] ?? 0;
  return `${id} ${cur}/${base}`;
}).join('，');
console.log(`[check-ui-consistency] 采用率（当前/基线）：${adoptionLine}`);
