// scripts/measure-settings-coverage.ts
// settings 目录覆盖率单列聚合（renderer-settings 层 measured 回填）：渲染层汇总
// 覆盖率把 settings 洼地（自记约 21%）平均掉了——债不可见就没人还。从 renderer
// coverage 产物（coverage-summary.json per-file 计数）按 components/settings 前缀
// 聚合四指标，回填 coverage-floors.json；与 test:coverage 同一次产出双口径，不重复跑测试

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCoverageFloors, METRIC_KEYS } from './lib/coverage-floors';

const ROOT = join(import.meta.dirname, '..');
const SUMMARY_PATH = join(ROOT, 'src', 'renderer', 'coverage', 'coverage-summary.json');
const FLOORS_PATH = join(ROOT, 'scripts', 'coverage-floors.json');
/** 聚合前缀（posix 化后匹配，兼容 Windows 反斜杠产物路径） */
const PREFIX = '/components/settings/';

interface FileCounts {
  readonly statements: { readonly covered: number; readonly total: number };
  readonly branches: { readonly covered: number; readonly total: number };
  readonly functions: { readonly covered: number; readonly total: number };
  readonly lines: { readonly covered: number; readonly total: number };
}

interface MetricPcts {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

function aggregate(): MetricPcts {
  const summary: Record<string, FileCounts & { total: unknown }> = JSON.parse(
    readFileSync(SUMMARY_PATH, 'utf8'),
  );
  const sums: Record<'statements' | 'branches' | 'functions' | 'lines', [number, number]> = {
    statements: [0, 0],
    branches: [0, 0],
    functions: [0, 0],
    lines: [0, 0],
  };
  let files = 0;
  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;
    if (!key.replace(/\\/g, '/').includes(PREFIX)) continue;
    files += 1;
    for (const metric of ['statements', 'branches', 'functions', 'lines'] as const) {
      const c = entry[metric];
      if (c === undefined) continue;
      sums[metric][0] += c.covered;
      sums[metric][1] += c.total;
    }
  }
  if (files === 0) {
    console.error(
      '[coverage:settings] ❌ coverage-summary.json 中无 settings 前缀条目——先跑 pnpm test:renderer --coverage',
    );
    process.exit(1);
  }
  const pct = (covered: number, total: number): number =>
    total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
  console.log(`[coverage:settings] settings 目录 ${files} 个文件：`);
  const out = {} as MetricPcts;
  for (const metric of ['statements', 'branches', 'functions', 'lines'] as const) {
    const [covered, total] = sums[metric];
    out[metric] = pct(covered, total);
    console.log(`  ${metric}: ${out[metric]}% (${covered}/${total})`);
  }
  return out;
}

/** 逐段替换真源里 rendererSettings 层的 measured/measuredAt（保 $comment 与缩进） */
function writeMeasured(pcts: MetricPcts): void {
  const raw = readFileSync(FLOORS_PATH, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const file = loadCoverageFloors(FLOORS_PATH);
  const recorded = file.layers['renderer-settings']?.measured;
  if (
    recorded !== undefined &&
    file.layers['renderer-settings']?.measuredAt === today &&
    METRIC_KEYS.every((m) => recorded[m] === pcts[m])
  ) {
    console.log('[coverage:settings] ✅ 真源已记录相同实测（幂等，无需回填）');
    return;
  }
  const layerStart = raw.indexOf('"renderer-settings"');
  if (layerStart < 0) {
    console.error(
      '[coverage:settings] ❌ 真源缺少 renderer-settings 层——请先在 coverage-floors.json 登记该层',
    );
    process.exit(1);
  }
  const layerSlice = raw.slice(layerStart);
  const replaced = layerSlice
    .replace(
      /"measured": \{[^}]*\},/,
      `"measured": { "statements": ${pcts.statements}, "branches": ${pcts.branches}, "functions": ${pcts.functions}, "lines": ${pcts.lines} },`,
    )
    .replace(/"measuredAt": "[^"]*"/, `"measuredAt": "${today}"`);
  if (replaced === layerSlice) {
    console.error('[coverage:settings] ❌ measured/measuredAt 未发生变化（替换失败）');
    process.exit(1);
  }
  writeFileSync(FLOORS_PATH, raw.slice(0, layerStart) + replaced, 'utf8');
  console.log(
    `[coverage:settings] ✅ 已回填 rendererSettings.measured（${today}）→ ${FLOORS_PATH}`,
  );
}

const pcts = aggregate();
if (!process.argv.slice(2).includes('--print')) {
  writeMeasured(pcts);
}
