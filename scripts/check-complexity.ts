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
