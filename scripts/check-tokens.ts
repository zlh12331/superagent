// scripts/check-tokens.ts
// 设计令牌审计（渲染层组件，违规即卡关），判据核在 scripts/lib/token-rules.ts：
// 铁律① 禁裸色值（24 色板全禁）/ ② 禁 dark: 双写（语义令牌承载双主题）/
// ④ flex+gap 替代 space-x/y / ⑤ w-N h-N 双写用 size-N / 禁 hex 硬编码 /
// 语义基色禁作文字色（2026-10-02 立规：基色压浅灰面 2.2-3.9:1 全不达 AA）/
// 字体栈 CJK 回退不变量（2026-10-09 立规：缺回退中文掉宋体，文件树/xterm 实测）
// 排除：test/、coverage/、测试文件、tokens.css（生成物，文件级豁免）；styles/ 各域
// css 已纳入（2026-09-24：目录粒度豁免曾把手写 styles 连同生成物一起放走）
// 运行：pnpm check:tokens

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scanCss, scanTsLike, type TokenViolation } from './lib/token-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIR = join(ROOT, 'src', 'renderer');
const EXCLUDE_DIRS = new Set(['test', 'coverage']);
const EXCLUDE_FILES = new Set(['tokens.css']);

// 存量豁免（新增违规仍卡关，重构为语义令牌后移除）：badge=shadcn 官方 destructive 变体；
// inline-approval-card/DialogHost=语义色背景上的白字（对比度需求）
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
      !entry.name.includes('.test.')
    ) {
      acc.push(join(dir, entry.name));
    } else if (entry.name.endsWith('.css') && !EXCLUDE_FILES.has(entry.name)) {
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
    `[check-tokens] ❌ ${violations.length} 处违规（铁律①裸色/②dark:/④space-*/⑤w+h/hex/文字层/字体回退）：`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
  }
  console.error(
    '[check-tokens] 修复指引：docs/design/10-component-design-spec.md 样式铁律 + DESIGN.md（仓库根）',
  );
  return 1;
}

process.exitCode = main();
