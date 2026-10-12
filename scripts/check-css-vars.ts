// scripts/check-css-vars.ts：CSS 变量引用完整性门禁——扫描 var(--x) 引用，断言每个都有定义
// 补 check:tokens 的盲区：它查裸色值/裸 z 数字，查不出「引用了不存在的令牌」，
// 而后者会被浏览器静默丢弃（比裸色值更隐蔽）；判据与豁免规则在 scripts/lib/css-vars.ts，反例测试同目录。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findMissingVars, scanCssVars } from './lib/css-vars';

const ROOT = join(import.meta.dirname, '..');
// 只覆盖第一方源码：产物与依赖目录由 SKIP_DIRS 兜底，无需在此枚举
const SCAN_DIRS = ['src'];

/** 扫描时跳过的目录名 */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'out', 'coverage', '.vite']);

/** 递归收集目标文件 */
function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (/\.(css|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): void {
  const defined = new Set<string>();
  const missing: Array<{ file: string; line: number; name: string }> = [];
  const files = SCAN_DIRS.flatMap((d) => collectFiles(join(ROOT, d)));
  let referenceCount = 0;

  // 两遍扫描：先并集全仓定义（tokens.css 的定义对全组件生效），再判缺失
  const scans = files.map((file) => {
    const scan = scanCssVars(readFileSync(file, 'utf8'));
    for (const name of scan.defined) defined.add(name);
    referenceCount += scan.references.length;
    return { file, scan };
  });
  for (const { file, scan } of scans) {
    const rel = file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').split('\\').join('/');
    for (const r of findMissingVars(scan.references, defined)) {
      missing.push({ file: rel, line: r.line, name: r.name });
    }
  }

  if (missing.length > 0) {
    console.error(`[check-css-vars] ❌ ${missing.length} 处 var() 引用无对应定义：`);
    for (const m of missing) {
      console.error(`  ${m.file}:${m.line}  ${m.name}`);
    }
    console.error(
      '[check-css-vars] 修复：改用已定义的令牌（见 src/renderer/styles/tokens.css），' +
        '或为运行时注入的变量加 RUNTIME_INJECTED_PREFIXES 前缀豁免',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[check-css-vars] ✅ 通过：${referenceCount} 处 var() 引用均有定义（扫描 ${files.length} 文件）`,
  );
}

main();
