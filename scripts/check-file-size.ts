// scripts/check-file-size.ts
// 文件体积门槛：净行 600 硬卡关 + 原始行 600 仅告警 + 棘轮基线只允许收紧
// 为什么原始行不卡关（2026-09-06）：本仓强制写注释，按物理行卡关等于惩罚文档化
// 的代码——存量 7 条超限里 5 条只因注释多被永久锁死；净行（去空行与纯注释行）
// 才是规范口径，原始行保留为告警
// 范围：src/{main,renderer,preload} + packages/*/src（契约层曾漏在扫描外，2026-08-30 纠正）
// 运行：pnpm check:file-size [--update-baseline [--force]]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSourceFiles, discoverPackageSrcDirs, measureFile } from './lib/file-metrics';
import {
  evaluateRatchet,
  formatMetrics,
  type Metrics,
  parseBaseline,
  proposeBaseline,
  renderProblems,
  serializeBaseline,
  wantsBaselineUpdate,
  wantsForce,
} from './lib/ratchet';

const ROOT = join(import.meta.dirname, '..');
const BASELINE_PATH = join(import.meta.dirname, 'check-file-size.baseline.json');
const LIMITS_PATH = join(import.meta.dirname, 'limits.json');
/** 文件大小门槛（单一真源：scripts/limits.json；与 check-functions 共用） */
function loadLimits(): { raw: number; net: number } {
  const parsed = JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as {
    fileSize?: { raw?: number; net?: number };
  };
  return {
    raw: parsed.fileSize?.raw ?? 600,
    net: parsed.fileSize?.net ?? 600,
  };
}
/** 卡关口径：净行 */
const { net: NET_LIMIT, raw: RAW_WARN_LIMIT } = loadLimits();
/** 棘轮只锁净行（原始行仅告警，不参与基线比对） */
const METRICS = ['net'] as const;

function scanDirs(): string[] {
  return [
    join(ROOT, 'src', 'main'),
    join(ROOT, 'src', 'renderer'),
    join(ROOT, 'src', 'preload'),
    ...discoverPackageSrcDirs(ROOT),
  ];
}

/** 违规判定：净行超限（唯一卡关口径，见文件头注释） */
function isViolating(m: { raw: number; net: number }): boolean {
  return m.net > NET_LIMIT;
}

/** 原始行告警：净行合规但物理行数偏大（注释密度高，仅提示） */
function isRawWarning(m: { raw: number; net: number }): boolean {
  return m.net <= NET_LIMIT && m.raw > RAW_WARN_LIMIT;
}

function loadBaseline(): Record<string, Metrics> {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-file-size] ❌ 基线读取失败（${BASELINE_PATH}）：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

function main(): number {
  const files = scanDirs().flatMap((d) => collectSourceFiles(d));
  const current = new Map<string, Metrics>();
  const violatingRows: Array<{ path: string; raw: number; net: number }> = [];
  const rawWarnings: Array<{ path: string; raw: number; net: number }> = [];

  for (const file of files) {
    const m = measureFile(ROOT, file);
    if (isRawWarning(m)) {
      rawWarnings.push(m);
    }
    if (!isViolating(m)) continue;
    current.set(m.path, { net: m.net });
    violatingRows.push(m);
  }

  const baseline = loadBaseline();

  if (wantsBaselineUpdate(process.argv.slice(2))) {
    const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
    writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
    console.log(
      `[check-file-size] 基线已更新：${Object.keys(baseline).length} → ${Object.keys(next).length} 条（${BASELINE_PATH}，请连同代码一起提交）`,
    );
    return 0;
  }

  const problems = evaluateRatchet(current, baseline, METRICS);
  const sorted = violatingRows.sort((a, b) => b.net - a.net);
  const rawWarnLines = rawWarnings
    .sort((a, b) => b.raw - a.raw)
    .map((w) => `  [warn] ${w.path}: raw ${w.raw}（净行 ${w.net} 合规，仅注释密度提示）`);

  if (problems.length === 0) {
    console.log(
      `[check-file-size] ✅ 通过：${files.length} 文件，${current.size} 处净行超限全部在棘轮基线内` +
        `（基线 ${Object.keys(baseline).length} 条，只允许收紧）`,
    );
    console.log(`  门槛：净 ≤${NET_LIMIT} 行（原始行 >${RAW_WARN_LIMIT} 仅告警）`);
    for (const r of sorted) {
      const base = baseline[r.path];
      console.log(
        `  存量 ${r.path}: net ${r.net} raw ${r.raw}（基线 net ${base?.['net'] ?? '-'}）`,
      );
    }
    for (const line of rawWarnLines) console.log(line);
    return 0;
  }

  console.error(`[check-file-size] ❌ ${problems.length} 处棘轮违规（门槛 net ${NET_LIMIT}）：`);
  for (const line of renderProblems(problems)) console.error(line);
  console.error(
    `[check-file-size] 当前净行超限 ${current.size} 处：\n${sorted.map((r) => `  ${r.path}: net ${r.net} raw ${r.raw}（${formatMetrics({ net: r.net }, METRICS)}）`).join('\n')}`,
  );
  console.error(
    '[check-file-size] 修复指引：拆文件（typescript-dev-standards-ai.md §工程）；已重构请跑 pnpm check:file-size --update-baseline 收紧基线',
  );
  return 1;
}

process.exitCode = main();
