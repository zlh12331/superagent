// scripts/check-tsdoc.ts
// TSDoc 覆盖门禁（规则 18.1）：export 的函数/类/接口/类型/enum 必须有 TSDoc
// ──────────────────────────────────────────────────────────────
// 落实 typescript-dev-standards-ai.md 规则 18.1 的自动门禁（此前无，debt.md#d3）。
// 判据核在 scripts/lib/tsdoc-rules.ts（@babel/parser AST，反例测试同目录）。
//
// 棘轮：per-file 基线（key = 文件相对路径，metric = count），只允许下降——
// 存量已清零（2026-09-25 落地日实测 75 处并全部补写；量化首跑的 1126 系判据
// 误判，修正 Export 节点锚定后 75 为真值，详见 debt.md#d3）；新代码即写即 100% 覆盖。
// 基线：scripts/tsdoc-baseline.json（--update-baseline 收紧）
//
// 运行：pnpm check:tsdoc
//       pnpm check:tsdoc --update-baseline   # 消化后收紧基线
// ──────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { scanTsdoc } from './lib/tsdoc-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [join(ROOT, 'src')];
const BASELINE_PATH = join(import.meta.dirname, 'tsdoc-baseline.json');
const METRICS = ['count'] as const;

/** 扫描时跳过的目录名（node_modules 双保险；coverage 为历史快照） */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'coverage', '.vite']);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    // 测试文件不参与（file:/// 引用等测试数据非产线文档）；index.ts 为 barrel
    // （export * from 形态，文档责任在被指向的声明）
    else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.') &&
      entry.name !== 'index.ts'
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  // current：仅含超限（count > 0）条目，per-file
  const current = new Map<string, Metrics>();
  let documented = 0;
  let constMissing = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const scan = scanTsdoc(content, rel);
    documented += scan.documented;
    constMissing += scan.constMissing;
    if (scan.missing.length > 0) current.set(rel, { count: scan.missing.length });
  }

  const total = [...current.values()].reduce((sum, m) => sum + (m['count'] ?? 0), 0);

  if (wantsBaselineUpdate(process.argv.slice(2))) {
    // 首次建立时允许无基线文件（空基线起步）
    const baseline = existsSync(BASELINE_PATH)
      ? parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS)
      : {};
    const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
    writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
    console.log(
      `[check-tsdoc] 基线已更新：${Object.keys(baseline).length} 文件 → ${Object.keys(next).length} 文件（存量 ${total} 处）`,
    );
    return 0;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('[check-tsdoc] ❌ 缺少基线文件 scripts/tsdoc-baseline.json');
    console.error('  首次建立：pnpm check:tsdoc --update-baseline');
    return 1;
  }
  let baseline: ReturnType<typeof parseBaseline>;
  try {
    baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-tsdoc] ❌ 基线读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

  const problems = evaluateRatchet(current, baseline, METRICS);
  if (problems.length > 0) {
    console.error(`[check-tsdoc] ❌ TSDoc 棘轮违规：`);
    for (const line of renderProblems(problems)) console.error(line);
    for (const rule of [
      '规则 18.1：export 的函数/类/接口/类型/enum 必须有 TSDoc（docs/design/typescript-dev-standards-ai.md）',
    ]) {
      console.error(`  ${rule}`);
    }
    console.error(
      '[check-tsdoc] 修复指引：为新 export 补 TSDoc（基于真实行为，勿模板化糊弄）；存量消化后跑 --update-baseline 收紧基线',
    );
    return 1;
  }

  console.log(
    `[check-tsdoc] ✅ 通过：${files.length} 文件，${total} 处存量在棘轮基线内（已文档化声明 ${documented}，export const 无注释 ${constMissing} 处不计入）`,
  );
  return 0;
}

process.exitCode = main();
