// scripts/check-comments.ts：过期注释门禁——扫描 src/**/*.{ts,tsx} 与 docs/design/、docs/implementation/ 的 .md（archive 冻结区不扫），报告注释与代码已漂移的位置
// 判据与规则实现在 scripts/lib/comments-rules.ts（反例测试同目录）；本文件只做收集、派发与退出码。
// 与 check:tsdoc 互补：后者拦「缺失 TSDoc」，本脚本规则 A 拦「过期 @param」（注释与签名漂移）。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type CommentProblem, createCommentRules } from './lib/comments-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [
  join(ROOT, 'src'),
  join(ROOT, 'docs', 'design'),
  join(ROOT, 'docs', 'implementation'),
];

/** 根 package.json scripts 键集合（规则 D 的存在性判据；加载失败即门禁自身失效，直接抛） */
const ROOT_SCRIPTS: ReadonlySet<string> = new Set(
  Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as object),
);

/** node_modules/.bin 内可用工具名（pnpm 对未知命令会回退 .bin，`pnpm drizzle-kit generate` 即合法） */
const BIN_STEMS: ReadonlySet<string> = (() => {
  try {
    return new Set(
      readdirSync(join(ROOT, 'node_modules', '.bin')).map((f) =>
        f.replace(/\.(cmd|ps1|exe|sh)$/i, ''),
      ),
    );
  } catch {
    return new Set();
  }
})();

const rules = createCommentRules({
  root: ROOT,
  rootScripts: ROOT_SCRIPTS,
  binStems: BIN_STEMS,
  todoStaleDays: 90,
});

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'archive') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.name.includes('.test.')) continue;
    else if (
      entry.name.endsWith('.ts') ||
      entry.name.endsWith('.tsx') ||
      entry.name.endsWith('.md')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const problems: CommentProblem[] = [];

  for (const file of files) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    rules.checkJsDoc(content, rel, problems);
    rules.checkFileRefs(content, rel, problems);
    rules.checkCommandRefs(content, rel, problems);
    if (file.startsWith(join(ROOT, 'src'))) rules.checkTodos(content, rel, problems);
  }

  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');

  if (errors.length === 0) {
    console.log(
      `[check-comments] ✅ 通过：${files.length} 文件，0 过期注释${warnings.length > 0 ? `（${warnings.length} 个 warning）` : ''}`,
    );
    for (const w of warnings) console.warn(`  ⚠️ ${w.file}:${w.line} [${w.rule}] ${w.detail}`);
    return 0;
  }

  console.error(`[check-comments] ❌ ${errors.length} 处过期注释（+${warnings.length} warning）：`);
  for (const p of errors) console.error(`  ${p.file}:${p.line} [${p.rule}] ${p.detail}`);
  for (const w of warnings) console.warn(`  ⚠️ ${w.file}:${w.line} [${w.rule}] ${w.detail}`);
  console.error(
    '[check-comments] 修复指引：更新注释以匹配当前代码（docs/design/10 规范 §五 组件文档模板）；规则 D 命中请改为 scripts 中真实存在的命令，或确认其属 pnpm 内置命令并补入 PNPM_BUILTIN',
  );
  return 1;
}

process.exitCode = main();
