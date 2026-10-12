// scripts/check-complexity.ts
// 认知复杂度门禁：函数认知复杂度 ≤15，按文件棘轮基线只允许收紧
// 为什么不按行数卡关：行数分不清「92 行 JSX 平铺」（声明式、低风险）与
// 「62 行控制流纠缠」（分支密集、真危险）——行数门槛放宽到 100 后后者会漏过，
// 本门禁按嵌套深度加权补上这条红线
// 为什么复用 Biome 而非自研（2026-09-11 决策）：首版手写度量（正则/AST 两版）
// 一个函数内暴露多个 bug 且 else-if/catch 计分与 Biome 实测不符——语义权威性
// 必须唯一，直接用内置规则 lint/complexity/noExcessiveCognitiveComplexity
// 数据通路：check:complexity 先产出 Biome JSON 报告，本脚本从标准输入读取
// （脚本内不起子进程；管道以末命令退出码为准，跨平台成立）
// 运行：pnpm check:complexity [--update-baseline]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const LIMITS_PATH = join(import.meta.dirname, 'limits.json');
const BASELINE_PATH = join(import.meta.dirname, 'check-complexity.baseline.json');
const METRICS = ['count', 'max'] as const;
// 以 --only 单独启用，不进 biome.json（否则 pnpm lint 会被 59 处存量一次性刷屏）；阈值取 Biome 默认 15
const RULE = 'lint/complexity/noExcessiveCognitiveComplexity';

function loadThreshold(): number {
  const parsed = JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as {
    complexity?: { max?: number };
  };
  return parsed.complexity?.max ?? 15;
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
    console.error('[check-complexity] 无法读取标准输入');
    process.exit(1);
  }
  const start = raw.indexOf('{');
  if (start === -1) {
    console.error('[check-complexity] 上游未输出 JSON');
    process.exit(1);
  }
  const parsed = JSON.parse(raw.slice(start)) as { diagnostics?: BiomeDiagnostic[] };
  return parsed.diagnostics ?? [];
}

function complexityOf(message: string | undefined): number | null {
  const m = (message ?? '').match(/complexity of (\d+)/);
  return m === null ? null : Number(m[1]);
}

function thresholdOf(message: string | undefined): number | null {
  const m = (message ?? '').match(/max: (\d+)/);
  return m === null ? null : Number(m[1]);
}

/**
 * 诊断 → 按文件的指标映射（count / max）
 *
 * 排除测试文件（`.test.ts*` 与 `__tests__/`）——与 check-functions /
 * check-file-size 的扫描口径一致：测试里的复杂度（长 setup、逐例断言）
 * 不是重构信号，纳入只会制造需要豁免的噪音。
 */
function toMetricMap(diagnostics: readonly BiomeDiagnostic[]): Map<string, Metrics> {
  const map = new Map<string, Metrics>();
  for (const d of diagnostics) {
    if (d.category !== RULE) continue;
    const rel = (d.location?.path ?? '').split('\\').join('/');
    if (rel === '' || rel.includes('.test.') || rel.includes('__tests__/')) continue;
    const value = complexityOf(d.message);
    if (value === null) continue;
    const entry = map.get(rel) ?? { count: 0, max: 0 };
    entry['count'] = (entry['count'] ?? 0) + 1;
    entry['max'] = Math.max(entry['max'] ?? 0, value);
    map.set(rel, entry);
  }
  return map;
}

function loadBaseline(): Record<string, Metrics> {
  if (!existsSync(BASELINE_PATH)) return {};
  return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
}

function main(): number {
  const expected = loadThreshold();
  const diagnostics = readBiomeJson();
  // 阈值自校验：诊断消息里含上游实际生效的阈值，与 limits.json 比对——
  // 防 Biome 改默认值或本地改配置后门禁静默失真
  const actual = thresholdOf(diagnostics.find((d) => d.category === RULE)?.message);
  if (actual !== null && actual !== expected) {
    console.error(`阈值漂移：上游 ${actual} vs 真源 ${expected}`);
    return 1;
  }
  const current = toMetricMap(diagnostics);
  const baseline = loadBaseline();
  const total = [...current.values()].reduce((sum, m) => sum + (m['count'] ?? 0), 0);

  if (wantsBaselineUpdate(process.argv.slice(2))) {
    const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
    writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
    console.log(`基线已更新：${Object.keys(next).length} 个文件（${total} 处）`);
    return 0;
  }

  const problems = evaluateRatchet(current, baseline, METRICS);
  if (problems.length > 0) {
    console.error(
      `[check-complexity] ❌ 认知复杂度棘轮违规 ${problems.length} 处（门槛 ≤${expected}）：`,
    );
    for (const line of renderProblems(problems)) console.error(line);
    console.error(
      '[check-complexity] 修复指引：嵌套控制流提取为具名函数、用卫语句（early return）扁平化、' +
        '拆分长条件为语义化布尔变量；已重构请带 --update-baseline 重跑',
    );
    return 1;
  }

  console.log(
    `[check-complexity] ✅ 通过：${current.size} 个文件 / ${total} 处认知复杂度超 ${expected}` +
      `（基线 ${Object.keys(baseline).length} 个文件，只允许收紧）`,
  );
  const worst = [...current.entries()].sort((a, b) => (b[1]['max'] ?? 0) - (a[1]['max'] ?? 0));
  if (worst.length > 0) {
    console.log('  最高复杂度 Top 5（供重构排期）：');
    for (const [file, m] of worst.slice(0, 5)) {
      console.log(`    max=${String(m['max']).padStart(3)}  count=${m['count']}  ${file}`);
    }
  }
  return 0;
}

process.exitCode = main();
