// scripts/check-functions.ts
// 函数参数审计（工程化强制）：参数 ≤4（对象封装豁免）
// ──────────────────────────────────────────────────────────────
// 依据 typescript-dev-standards-ai.md §函数（参数≤4 对象封装）
// 与业界实践（eslint max-params 常见 3-4）。
// 实现说明：根 typescript@7 不暴露编译器 API（native port），
// 采用正则解析（多行/可选/默认值/解构豁免已覆盖，对齐 check-comments 经验）。
// 函数体 ≤40 行依赖 AST，由 TypeDoc/代码评审兜底（文档标注）。
// 级别：默认 warning（摸底存量）；--strict 时 error 卡关（存量清零后切换）。
//
// 运行：pnpm check:functions [--strict]
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [join(ROOT, 'src', 'main'), join(ROOT, 'src', 'renderer')];
const PARAM_LIMIT = 4;

// 豁免：DI 装配集合点（依赖注入函数参数多为服务实例，业界 max-params 对注入点放宽）
const EXEMPT_FUNCTIONS = new Set(['registerBuiltinTools']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      if (!entry.name.includes('.test.') && !entry.name.includes('mock-api')) acc.push(full);
    }
  }
  return acc;
}

/** 提取函数签名参数（跨行/可选/默认值），返回参数名列表；解构对象返回 null（对象封装豁免） */
function extractParams(signature: string): string[] | null {
  const paren = signature.match(/\(([\s\S]*)\)/);
  if (paren === null) return [];
  const params = paren[1];
  // 解构对象/数组参数 → 对象封装，整函数豁免
  if (/\{\s*[^}]*\}/.test(params) || /\[\s*[^\]]*\]/.test(params)) return null;
  const names: string[] = [];
  for (const p of params.split(',')) {
    const clean = p.trim().replace(/^\.\.\./, '');
    if (clean === '') continue;
    const name = clean.split(':')[0]?.trim().replace(/\?$/, '').split('=')[0]?.trim();
    if (name && !name.includes(' ')) names.push(name);
  }
  return names;
}

/** 正则扫描函数签名（function 声明 + 箭头函数 + 方法），跳过注释行 */
function checkFile(file: string, findings: Finding[]): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const fnRe =
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*(?::[^{}]*)?(?=\s*\{)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([\s\S]*?)\)|(\w+))\s*=>/g;
  const source = lines.join('\n');

  for (const m of source.matchAll(fnRe)) {
    const name = m[1] ?? m[3] ?? 'anonymous';
    const paramsText = m[2] ?? m[4];
    if (paramsText === undefined) continue;
    if (EXEMPT_FUNCTIONS.has(name)) continue; // DI 装配豁免
    // 跳过注释中的函数声明
    const lineNo = source.slice(0, m.index).split('\n').length;
    const line = lines[lineNo - 1]?.trim() ?? '';
    if (line.startsWith('//') || line.startsWith('*')) continue;

    const params = extractParams(m[0]);
    if (params === null) continue; // 解构对象封装豁免
    if (params.length > PARAM_LIMIT) {
      findings.push({
        file: rel,
        line: lineNo,
        detail: `${name}() 参数 ${params.length} 个 > ${PARAM_LIMIT}（应对象封装：${params.join(', ')}）`,
      });
    }
  }
}

function main(): number {
  // 存量已清零（2026-08-11），默认 error 卡关；--no-strict 可降级观察
  const strict = !process.argv.includes('--no-strict');
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const findings: Finding[] = [];
  for (const file of files) checkFile(file, findings);

  if (findings.length === 0) {
    console.log(`[check-functions] ✅ 通过：${files.length} 文件，0 参数超限`);
    return 0;
  }

  console.log(
    `[check-functions] ${strict ? '❌' : '⚠️'} ${findings.length} 处参数 >${PARAM_LIMIT}${strict ? '' : '（--no-strict 观察模式）'}：`,
  );
  for (const f of findings.slice(0, 30)) {
    console.log(`  ${f.file}:${f.line} ${f.detail}`);
  }
  if (findings.length > 30) console.log(`  … 其余 ${findings.length - 30} 处省略`);
  return strict && findings.length > 0 ? 1 : 0;
}

process.exitCode = main();
