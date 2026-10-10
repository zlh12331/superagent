import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findMissingVars, scanCssVars } from './lib/css-vars';

const ROOT = join(import.meta.dirname, '..');
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
