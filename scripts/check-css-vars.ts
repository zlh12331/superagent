// scripts/check-css-vars.ts
// CSS 变量引用完整性门禁：扫描 var(--x) 引用，断言每个都有定义
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-14）：实测发现 5 处 var(--x) 引用了从未定义的令牌
// （--z-dropdown / --z-raised / --bg-elev-1 / --text-muted / --accent-2-dim），
// 导致对应 CSS 声明被浏览器静默丢弃——比裸色值更隐蔽：
//   check:tokens 查「裸色值/裸 z 数字」能查，
//   但查不出「引用了不存在的令牌」。
// 本门禁补上这个盲区（与 check:csp-hash / check:compiler 同属「防静默失效」家族）。
//
// 豁免（按需，均需在下方给出理由）：
// - 运行时注入：Radix 等库在运行时设置（--radix-*）；Tailwind v4 动态前缀（--spacing 等）
// - 带 fallback 的引用：var(--x, fallback) 即使 --x 未定义也有确定取值，不算失效
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = ['src'];

/** 扫描时跳过的目录名 */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'out', 'coverage', '.vite']);

/**
 * 允许「被引用但不在本仓定义」的变量前缀
 *
 * 这些由外部环境在运行时注入，静态扫描必然看不到定义：
 */
const RUNTIME_INJECTED_PREFIXES: readonly string[] = [
  '--radix-', // Radix UI 运行时注入尺寸（如 --radix-select-trigger-width）
  '--spacing', // Tailwind v4 动态 spacing 前缀（--spacing-md 等在 @theme 计算生成）
];

/** 单个文件发现的引用 */
interface Reference {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

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

/**
 * 提取一行中的 var(--x) 引用
 *
 * 带 fallback 的写法（var(--x, #fff)）**不计入**：即使 --x 未定义也有确定取值。
 * 注释行整体跳过：说明文字里常写 `var(--x)` 举例（实测 terminal.tsx 头注释即如此），
 * 那不是真实引用。
 */
function extractRefs(line: string): string[] {
  const trimmed = line.trim();
  // 单行注释 / 块注释续行（* 开头）/ CSS 注释内容行
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return [];
  }
  const refs: string[] = [];
  for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
    const name = match[1];
    const next = match[2];
    if (name === undefined) continue;
    // 紧跟 ',' 说明有 fallback → 跳过
    if (next === ',') continue;
    refs.push(name);
  }
  return refs;
}

/** 是否为运行时注入（豁免） */
function isRuntimeInjected(name: string): boolean {
  return RUNTIME_INJECTED_PREFIXES.some((p) => name.startsWith(p));
}

function main(): void {
  const defined = new Set<string>();
  const references: Reference[] = [];
  const files = SCAN_DIRS.flatMap((d) => collectFiles(join(ROOT, d)));

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const rel = file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').split('\\').join('/');
    lines.forEach((line, i) => {
      // 定义：`--name:` 形态（CSS 自定义属性声明）
      for (const m of line.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
        if (m[1] !== undefined) defined.add(m[1]);
      }
      for (const name of extractRefs(line)) {
        references.push({ name, file: rel, line: i + 1 });
      }
    });
  }

  const missing = references.filter((r) => !defined.has(r.name) && !isRuntimeInjected(r.name));

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
    `[check-css-vars] ✅ 通过：${references.length} 处 var() 引用均有定义（扫描 ${files.length} 文件）`,
  );
}

main();
