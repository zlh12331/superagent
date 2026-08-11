// scripts/check-file-size.ts
// 文件净行数门槛（工程化强制）：新文件 ≤600 净行（业界 eslint max-lines 建议区间上限）
// ──────────────────────────────────────────────────────────────
// 依据 eslint max-lines 官方建议（100-500 区间，本项目取 600 容忍 TS/React 组件文件）
// 与 typescript-dev-standards-ai.md §工程 同步修订。
// 净行 = 总行数 - 空行 - 纯注释行（对齐 eslint 的 skipBlankLines + skipComments 选项）。
// 策略：豁免清单记录存量超限文件（2026-08-11 基线 1 个），清单外文件超限即卡关。
//
// 运行：pnpm check:file-size
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [
  join(ROOT, 'src', 'main'),
  join(ROOT, 'src', 'renderer'),
  join(ROOT, 'src', 'preload'),
];
const LIMIT = 600;

// 存量超限豁免清单（2026-08-11 基线 2 个；重构拆短后移除）
const EXEMPT = new Set([
  'src/renderer/dev/mock-api.ts',
  'src/main/infra/ai/agent/agent-service.ts', // 601 净行，重构时优先拆
]);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      if (!entry.name.includes('.test.')) acc.push(full);
    }
  }
  return acc;
}

/** 净行数：跳过空行与纯注释行（eslint max-lines skipBlankLines + skipComments） */
function countNetLines(file: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;
  let net = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('*')) continue;
    net++;
  }
  return net;
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const problems: Array<{ file: string; lines: number }> = [];

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = countNetLines(file);
    if (lines > LIMIT && !EXEMPT.has(rel)) {
      problems.push({ file: rel, lines });
    }
  }

  if (problems.length === 0) {
    console.log(
      `[check-file-size] ✅ 通过：${files.length} 文件，0 超限（门槛 ${LIMIT} 净行，豁免 ${EXEMPT.size} 个存量）`,
    );
    return 0;
  }

  console.error(`[check-file-size] ❌ ${problems.length} 个文件超 ${LIMIT} 净行（豁免清单外）：`);
  for (const p of problems) console.error(`  ${p.file}: ${p.lines} 净行`);
  console.error(
    '[check-file-size] 修复指引：拆分文件；存量文件移除豁免需先重构（typescript-dev-standards-ai.md §工程）',
  );
  return 1;
}

process.exitCode = main();
