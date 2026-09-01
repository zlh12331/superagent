// scripts/check-file-size.ts
// 文件体积门槛（工程化强制）：原始行 + 净行双口径 + 棘轮基线
// ──────────────────────────────────────────────────────────────
// 规则（两条同时生效，缺一即被绕过）：
//   RAW_LIMIT = 600 原始行——物理行数，无法靠注释刷量规避（业界 eslint max-lines 口径）
//   NET_LIMIT = 600 净行——去掉空行/纯注释后的代码量（对齐 skipBlankLines + skipComments）
// 范围：src/{main,renderer,preload} + packages/*/src（契约层曾长期在扫描范围外，
//       definitions.ts 932 原始行无人管，2026-08-30 审计纠正）。
//
// 存量违规不再写在源码里的豁免清单（会漂移、会谎报行数），而是外置为
// scripts/check-file-size.baseline.json，按 lib/ratchet.ts 的棘轮规则单向收紧：
//   新增超限 / 基线值变大 / 基线条目已消解未清理 → 均卡关
//
// 运行：pnpm check:file-size
//       pnpm check:file-size --update-baseline   # 重构后收紧基线
//       （--force 才允许写高基线值，等价于「显式承认放宽」，diff 可见）
// ──────────────────────────────────────────────────────────────

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
const { raw: RAW_LIMIT, net: NET_LIMIT } = loadLimits();
const METRICS = ['raw', 'net'] as const;

function scanDirs(): string[] {
  return [
    join(ROOT, 'src', 'main'),
    join(ROOT, 'src', 'renderer'),
    join(ROOT, 'src', 'preload'),
    ...discoverPackageSrcDirs(ROOT),
  ];
}

/** 超限判定：任一口径超限即进入违规集 */
function isViolating(m: { raw: number; net: number }): boolean {
  return m.raw > RAW_LIMIT || m.net > NET_LIMIT;
}

function loadBaseline(): Record<string, Metrics> {
  // 文件缺失 → 空基线（首次 --update-baseline 得以创建；普通运行把所有超限报成 new）
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

  for (const file of files) {
    const m = measureFile(ROOT, file);
    if (!isViolating(m)) continue;
    current.set(m.path, { raw: m.raw, net: m.net });
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
  const sorted = violatingRows.sort((a, b) => b.raw - a.raw);

  if (problems.length === 0) {
    console.log(
      `[check-file-size] ✅ 通过：${files.length} 文件，${current.size} 处超限全部在棘轮基线内` +
        `（基线 ${Object.keys(baseline).length} 条，只允许收紧）`,
    );
    console.log(`  门槛：原始 ≤${RAW_LIMIT} 行 / 净 ≤${NET_LIMIT} 行`);
    for (const r of sorted) {
      const base = baseline[r.path];
      console.log(
        `  存量 ${r.path}: raw ${r.raw} net ${r.net}（基线 raw ${base?.raw ?? '-'} / net ${base?.net ?? '-'}）`,
      );
    }
    return 0;
  }

  console.error(
    `[check-file-size] ❌ ${problems.length} 处棘轮违规（门槛 raw ${RAW_LIMIT} / net ${NET_LIMIT}）：`,
  );
  for (const line of renderProblems(problems)) console.error(line);
  console.error(
    `[check-file-size] 当前超限 ${current.size} 处：\n${sorted.map((r) => `  ${r.path}: raw ${r.raw} net ${r.net}（${formatMetrics(r, METRICS)}）`).join('\n')}`,
  );
  console.error(
    '[check-file-size] 修复指引：拆文件（typescript-dev-standards-ai.md §工程）；已重构请跑 pnpm check:file-size --update-baseline 收紧基线',
  );
  return 1;
}

process.exitCode = main();
