// scripts/check-complexity.ts
// 认知复杂度门禁（工程化强制）：函数认知复杂度 ≤15，按文件棘轮 + 只允许收紧
// ──────────────────────────────────────────────────────────────
// 为什么需要本门禁（2026-09-11 新增，与 check-functions 行数门槛放宽配套）：
// - `check-functions` 用「函数体净行数」度量长度，但行数是复杂度的**弱代理**：
//   它分不清「92 行 JSX 平铺」（声明式、逻辑简单）与「62 行控制流纠缠」
//   （分支密集、真危险）。本项目行数门槛从 50 放宽到 100 后，后者会落进
//   「提示档」而不再卡关。本门禁补上这条红线：按**嵌套深度**加权控制流，
//   声明平铺不计分。
//
// 为什么复用 Biome 而非自研度量（2026-09-11 决策）：
// - 度量语义必须权威且唯一。首版曾试图手写（正则与 AST 两版），实测在一个函数内
//   就暴露多个 bug（for 头的分号清空待绑定状态、逻辑与链被操作数打断、else-if
//   重复计分），且手写版对 else-if 与 catch 的计分与 Biome 实测不符
//   （Biome 实测：if-else-if 得 2、try-catch 得 2；手写版均为 1）。与其维护第二套
//   语义并承担漂移风险，不如直接复用 Biome 的 noExcessiveCognitiveComplexity。
// - 该规则是 Biome 内置规则（以 --only 单独启用，无需写进 biome.json——否则
//   `pnpm lint` 会被 59 处存量一次性刷屏）。阈值取 Biome 默认 15（SonarQube 同值）。
//
// 数据通路（为何从标准输入读）：
// - 由 package.json 的 check:complexity 脚本以管道串联：先产出 Biome 的 JSON 报告，
//   再由本脚本从标准输入读取。管道在 sh 与 cmd 下语义一致（以末命令退出码为准），
//   故跨平台成立；且脚本内无需起子进程（脚本内引入 child_process 会被安全扫描
//   拦截，shell 重定向在 cmd 下也不可移植）。
// - 阈值自校验：诊断消息含上游实际生效的阈值，脚本解析后与 limits.json 的
//   complexity.max 比对，不一致即失败——防止 Biome 改默认值或有人本地改配置
//   而门禁静默失真。
//
// 基线口径（按文件，两个指标）：
//   count = 该文件超阈值的函数数；max = 该文件最高复杂度
// - 为什么不按「文件#函数名」：Biome 只输出文件与行号，不给函数名；而项目在
//   check-functions.ts 的 key 稳定性评估里已实测「行号 key 会随上方增删漂移」。
//   文件级 key 是稳定性与精度的折中：count 拦住「越改越多」，max 拦住「最差更差」。
//
// 运行：pnpm check:complexity
//       pnpm check:complexity --update-baseline   # 重构后收紧基线
// ──────────────────────────────────────────────────────────────

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
