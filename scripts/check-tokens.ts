// scripts/check-tokens.ts
// 设计令牌审计（工程化强制）：扫描渲染层组件，违规即卡关（exit 1）
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/10-component-design-spec.md 样式铁律 + DESIGN.md：
//   铁律① 语义令牌优先，禁裸色值（24 色板全禁用）
//   铁律② 禁手动 dark: 双写（双主题差异用语义令牌）
//   铁律④ flex+gap 替代 space-x/y
//   铁律⑤ 宽高相等用 size-N，禁 w-N h-N 双写
//   硬编码颜色（#hex 出现在 className/内联样式）禁用
//   语义基色禁作 color: 文字色（text-base-color，2026-10-02 立规：
//   基色压浅灰面 2.2-3.9:1 全不达 AA，文字走对应 *-text 层）
// 判据核在 scripts/lib/token-rules.ts（反例测试同目录）。
//
// 运行：pnpm check:tokens
// 排除：styles/（令牌定义处）、测试文件（*.test.*）、注释行、动态样式（style 内变量表达式）
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scanCss, scanTsLike, type TokenViolation } from './lib/token-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIR = join(ROOT, 'src', 'renderer');
// 目录排除仅剩 test 与 coverage（测试与覆盖率报告产物）；styles 目录**不再整体排除**
// （2026-09-24：目录粒度豁免曾把手写的 styles/* 与生成物一起放走，硬编码 hex 无人管辖）。
// 文件粒度豁免：tokens.css 是 aurora.json 的生成物（hex 为令牌定义本身，必然存在）。
const EXCLUDE_DIRS = new Set(['test', 'coverage']);
const EXCLUDE_FILES = new Set(['tokens.css']);

// 存量豁免基线（白/黑裸色历史用法，新增违规仍卡关；重构为语义令牌后移除）：
//   badge.tsx = shadcn 官方 destructive 变体；
//   inline-approval-card / DialogHost = 语义色背景上的白字（对比度需求）
// 已移除 browser-pane：原豁免理由是「iframe 白底」，但 v1 iframe 方案已被
// WebContentsView 取代，该容器已改用语义令牌 bg-background（深色主题不再白底）。
const MONO_EXEMPT_FILES = new Set([
  'src/renderer/components/ui/badge.tsx',
  'src/renderer/components/agent/inline-approval-card.tsx',
  'src/renderer/components/common/DialogHost.tsx',
]);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collectFiles(join(dir, entry.name), acc);
    } else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      // 测试文件不参与令牌审计（此前按 __tests__ 目录排除，测试改为与源码同目录后按文件名排除）
      !entry.name.includes('.test.')
    ) {
      acc.push(join(dir, entry.name));
    } else if (entry.name.endsWith('.css') && !EXCLUDE_FILES.has(entry.name)) {
      // css 纳入管辖（2026-09-24）：此前只扫 .ts/.tsx，styles/ 各域 css 的硬编码 hex 完全不在范围
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function main(): number {
  const files = collectFiles(SCAN_DIR);
  const violations: TokenViolation[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) violations.push(...scanCss(content, rel));
    else violations.push(...scanTsLike(content, rel, MONO_EXEMPT_FILES.has(rel)));
  }

  if (violations.length === 0) {
    console.log(`[check-tokens] ✅ 通过：${files.length} 个文件，0 违规`);
    return 0;
  }

  console.error(
    `[check-tokens] ❌ ${violations.length} 处违规（铁律①裸色/②dark:/④space-*/⑤w+h/hex/文字层）：`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
  }
  console.error(
    '[check-tokens] 修复指引：docs/design/10-component-design-spec.md 样式铁律 + DESIGN.md',
  );
  return 1;
}

process.exitCode = main();
