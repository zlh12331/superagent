// scripts/check-comments.ts
// 注释一致性审计（工程化强制）：发现"过期注释"（注释与代码漂移）
// ──────────────────────────────────────────────────────────────
// 规则（判据核在 scripts/lib/comments-rules.ts，反例测试同目录）：
//   A. JSDoc @param 与函数签名一致性——@param 名在签名中不存在 = 过期注释
//   B. 注释/文档中 file:/// 引用路径存在性 + #L行号 越界检查
//   C. TODO/FIXME 过期——带日期超 90 天 = error；无日期 = warning
//   D. pnpm 命令引用存在性——非内置/scripts/.bin 的命令引用 = 过期
// 范围：src/**/*.{ts,tsx} + docs/design/*.md
//
// 分工说明（2026-09-25）：
//   - "缺失 TSDoc"（规则 18.1）由 check:tsdoc（scripts/lib/tsdoc-rules.ts）拦截；
//   - 本脚本规则 A 拦"过期 @param"（注释与签名漂移）——两者互补。
//     原「已知盲区」登记（debt.md#d3）已随 check:tsdoc 落地关闭。
//
// 运行：pnpm check:comments
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type CommentProblem, createCommentRules } from './lib/comments-rules';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'docs', 'design')];

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
    return new Set(); // .bin 不存在（未装依赖）时跳过该判据，不阻断门禁
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
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    // 测试文件不参与注释审计（此前按 __tests__ 目录排除，测试改为与源码同目录后按文件名排除）
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
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // 测试文件内 file:/// 为测试数据
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    rules.checkJsDoc(content, rel, problems);
    rules.checkFileRefs(content, rel, problems);
    rules.checkCommandRefs(content, rel, problems);
    // TODO 过期检查仅针对 src 代码（docs 文档内 TODO 为格式示例，非待办管理对象）
    // 注：file 为绝对路径，必须与 ROOT 拼接后的 src 前缀比较（此前误用相对串
    // 'src' 导致条件恒假，TODO 检查静默失效）
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
