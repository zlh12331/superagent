import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scanCss, scanTsLike, type TokenViolation } from './lib/token-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIR = join(ROOT, 'src', 'renderer');
const EXCLUDE_DIRS = new Set(['test', 'coverage']);
const EXCLUDE_FILES = new Set(['tokens.css']);

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
