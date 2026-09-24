// scripts/check-css-vars.ts
// CSS 变量引用完整性门禁：扫描 var(--x) 引用，断言每个都有定义
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-14）：实测发现 5 处 var(--x) 引用了从未定义的令牌
// （--z-dropdown / --z-raised / --bg-elev-1 / --text-muted / --accent-2-dim），
// 导致对应 CSS 声明被浏览器静默丢弃——比裸色值更隐蔽：
//   check:tokens 查「裸色值/裸 z 数字」能查，
//   但查不出「引用了不存在的令牌」。
// 本门禁补上这个盲区（与 check:csp-hash / check:compiler 同属「防静默失效」家族）。
// 判据核在 scripts/lib/css-vars.ts（反例测试同目录）。
//
// 豁免（按需，均需给出理由）：
// - 运行时注入：Radix 等库在运行时设置（--radix-*）；Tailwind v4 动态前缀（--spacing 等）
// - 带 fallback 的引用：var(--x, fallback) 即使 --x 未定义也有确定取值，不算失效
//
// 运行：pnpm check:css-vars
// ──────────────────────────────────────────────────────────────

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
