// scripts/check-comments.ts
// 注释一致性审计（工程化强制）：发现"过期注释"（注释与代码漂移）
// ──────────────────────────────────────────────────────────────
// 规则：
//   A. JSDoc @param 与函数签名一致性——@param 名在签名中不存在 = 过期注释（参数已改名/删除）
//      （反向"参数缺 @param"不报：属注释缺失，非过期）
//   B. 注释/文档中 file:/// 引用路径存在性 + #L行号 越界检查
//   C. TODO/FIXME 过期——带日期超 90 天 = error；无日期 = warning（提示补日期）
// 范围：src/**/*.{ts,tsx} + docs/design/*.md
//
// 运行：pnpm check:comments
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'docs', 'design')];
const TODO_STALE_DAYS = 90;

interface Problem {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
  readonly level: 'error' | 'warning';
}

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

/** 提取函数前的 JSDoc 块：/** ... *\/ */
function extractJsDocBlocks(content: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const re = /\/\*\*([\s\S]*?)\*\//g;
  for (const m of content.matchAll(re)) {
    blocks.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  }
  return blocks;
}

/** 从 JSDoc 块提取 @param 名集合（仅 {Type} name 或 name 形式，name 为第二捕获组） */
function extractParamNames(jsdoc: string): Set<string> {
  const names = new Set<string>();
  // {Type} name 或 name；name 之后才允许描述文字
  const re = /@param\s+(?:\{([^}]+)\}\s+)?([A-Za-z_$][\w$]*)/g;
  for (const m of jsdoc.matchAll(re)) {
    const name = m[2];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** 从函数签名提取参数名（支持简单签名、可选参数与解构对象属性） */
function extractSignatureParams(signature: string): Set<string> {
  const names = new Set<string>();
  const params = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
  // 解构对象参数 { a: T; b: T } → 属性名并入（JSDoc 常以 @param a 描述解构属性；TS 对象类型用 ; 分隔）
  const destructured = params.match(/\{\s*([^}]+)\}/);
  if (destructured) {
    for (const p of destructured[1].split(/[;,]/)) {
      const name = p
        .trim()
        .split(':')[0]
        ?.trim()
        .replace(/^readonly\s+/, '')
        .replace(/\?$/, '');
      if (name && !name.includes(' ')) names.add(name);
    }
  }
  for (const p of params.split(',')) {
    const clean = p.trim().replace(/^\.\.\./, '');
    if (clean === '') continue;
    // 去类型/默认值/可选标记：name?: Type = default → name
    const name = clean.split(':')[0]?.trim().replace(/\?$/, '').split('=')[0]?.trim();
    if (name && !name.includes(' ')) names.add(name);
  }
  return names;
}

/** 规则 A：JSDoc @param 与函数签名一致性 */
function checkJsDoc(content: string, file: string, problems: Problem[]): void {
  const blocks = extractJsDocBlocks(content);
  if (blocks.length === 0) return;

  // 函数签名模式（跨行参数 + 返回类型，前瞻函数体 {）：JSDoc 块之后的函数声明/箭头函数
  const fnRe =
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*(?::[^{}]*)?(?=\s*\{)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([\s\S]*?)\)|(\w+))\s*=>|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(([\s\S]*?)\)/g;

  for (const block of blocks) {
    fnRe.lastIndex = block.end;
    const m = fnRe.exec(content);
    if (m === null) continue;
    // JSDoc 与函数之间只允许空白/装饰符（间隔 ≤ 2 行且无非声明代码）
    const gap = content.slice(block.end, m.index);
    const gapLines = gap.split('\n').length - 1;
    if (gapLines > 2) continue;
    if (/[a-zA-Z0-9_$]/.test(gap.replace(/\s/g, ''))) continue;
    const signature = m[0];
    const signatureParams = extractSignatureParams(signature);
    if (signatureParams.size === 0) continue;

    const docParams = extractParamNames(block.text);
    const lineNo = content.slice(0, block.start).split('\n').length;

    for (const doc of docParams) {
      if (!signatureParams.has(doc)) {
        problems.push({
          file,
          line: lineNo,
          rule: 'stale-param',
          detail: `JSDoc @param '${doc}' 不存在于签名 ${signature.slice(0, 60)}…`,
          level: 'error',
        });
      }
    }
  }
}

/** 规则 B：file:/// 引用路径 + #L 行号有效性 */
function checkFileRefs(content: string, file: string, problems: Problem[]): void {
  const re = /file:\/\/\/([^)\s"`]+)/g;
  for (const m of content.matchAll(re)) {
    const raw = m[1];
    // 模板字符串插值（如 `file:///${dir.replace(...)}` 构造运行时 URL）
    // 无法静态验证路径存在性 → 跳过（避免把真实业务代码误报为过期引用）
    if (raw.includes('${')) continue;
    const [pathPart, linePart] = raw.split('#L');
    // docs 内为绝对路径（f:/...），src 注释内为相对路径
    const abs = pathPart.includes(':') ? pathPart : join(ROOT, pathPart.replace(/^\/+/, ''));
    const lineNo = content.slice(0, m.index).split('\n').length;
    if (!statSync(abs, { throwIfNoEntry: false })) {
      problems.push({
        file,
        line: lineNo,
        rule: 'stale-file-ref',
        detail: `file:/// 引用不存在：${pathPart}`,
        level: 'error',
      });
      continue;
    }
    if (linePart !== undefined) {
      const targetLines = readFileSync(abs, 'utf8').split('\n').length;
      const refLine = Number.parseInt(linePart, 10);
      if (Number.isFinite(refLine) && refLine > targetLines) {
        problems.push({
          file,
          line: lineNo,
          rule: 'stale-line-ref',
          detail: `#L${refLine} 超出 ${pathPart} 实际行数（${targetLines}）`,
          level: 'error',
        });
      }
    }
  }
}

/** 规则 C：TODO/FIXME 过期 */
function checkTodos(content: string, file: string, problems: Problem[]): void {
  const re = /\b(TODO|FIXME|HACK)\b[:(]?\s*(\d{4}-\d{2}-\d{2})?/g;
  for (const m of content.matchAll(re)) {
    const lineNo = content.slice(0, m.index).split('\n').length;
    const date = m[2];
    if (date === undefined) {
      problems.push({
        file,
        line: lineNo,
        rule: 'todo-no-date',
        detail: `${m[1]} 无日期（建议格式 TODO(YYYY-MM-DD)）`,
        level: 'warning',
      });
      continue;
    }
    const days = (Date.now() - Date.parse(date)) / 86_400_000;
    if (days > TODO_STALE_DAYS) {
      problems.push({
        file,
        line: lineNo,
        rule: 'todo-stale',
        detail: `${m[1]}(${date}) 已 ${Math.floor(days)} 天未处理（> ${TODO_STALE_DAYS} 天）`,
        level: 'error',
      });
    }
  }
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const problems: Problem[] = [];

  for (const file of files) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // 测试文件内 file:/// 为测试数据
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    checkJsDoc(content, rel, problems);
    checkFileRefs(content, rel, problems);
    // TODO 过期检查仅针对 src 代码（docs 文档内 TODO 为格式示例，非待办管理对象）
    // 注：file 为绝对路径，必须与 ROOT 拼接后的 src 前缀比较（此前误用相对串
    // 'src' 导致条件恒假，TODO 检查静默失效）
    if (file.startsWith(join(ROOT, 'src'))) checkTodos(content, rel, problems);
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
    '[check-comments] 修复指引：更新注释以匹配当前代码（docs/design/10 规范 §五 组件文档模板）',
  );
  return 1;
}

process.exitCode = main();
