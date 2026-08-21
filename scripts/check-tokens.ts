// scripts/check-tokens.ts
// 设计令牌审计（工程化强制）：扫描渲染层组件，违规即卡关（exit 1）
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/10-component-design-spec.md 样式铁律 + DESIGN.md：
//   铁律① 语义令牌优先，禁裸色值（24 色板全禁用）
//   铁律② 禁手动 dark: 双写（双主题差异用语义令牌）
//   铁律④ flex+gap 替代 space-x/y
//   铁律⑤ 宽高相等用 size-N，禁 w-N h-N 双写
//   硬编码颜色（#hex 出现在 className/内联样式）禁用
//
// 运行：pnpm check:tokens
// 排除：styles/（令牌定义处）、__tests__/、注释行、动态样式（style 内变量表达式）
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIR = join(ROOT, 'src', 'renderer');
const EXCLUDE_DIRS = new Set(['styles', '__tests__', 'test']);

// 24 色板 + 常用派生色（Tailwind 裸色值检测）
const COLOR_PALETTE = [
  'red',
  'blue',
  'green',
  'gray',
  'slate',
  'amber',
  'emerald',
  'zinc',
  'orange',
  'purple',
  'yellow',
  'indigo',
  'sky',
  'teal',
  'rose',
  'violet',
  'cyan',
  'pink',
  'white',
  'black',
  'magenta',
  'lime',
  'fuchsia',
];

// 裸色类模式：bg-red-500 / text-blue-600 / border-amber-200 等
const BARE_COLOR_RE = new RegExp(
  `(?:^|\\s)(bg|text|border|ring|from|to|via|divide|outline|fill|stroke|shadow)-(${COLOR_PALETTE.join('|')})-[0-9]+`,
  'g',
);

// 手动 dark: 双写
const DARK_OVERRIDE_RE = /(?:^|\s)dark:[a-z-]+/g;

// space-x/y
const SPACE_UTIL_RE = /(?:^|\s)space-[xy]-[0-9.]+/g;

// className 中的硬编码 hex 颜色
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

// className 中的硬编码 rgba()/rgb() 颜色（此前只查 #hex，rgba 色会漏网）
const RGB_COLOR_RE = /rgba?\([^\n)]*\)/g;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collectTsxFiles(join(dir, entry.name), acc);
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function checkFile(file: string, violations: Violation[]): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;
    const rel = relative(ROOT, file);

    for (const m of line.matchAll(BARE_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'bare-color', detail: m[0].trim() });
    }
    for (const m of line.matchAll(DARK_OVERRIDE_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'dark-override', detail: m[0].trim() });
    }
    for (const m of line.matchAll(SPACE_UTIL_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'space-util', detail: m[0].trim() });
    }
    // 仅当 className 字符串中出现 w-N 与 h-N 且数值相等（size-N 语义）
    const classMatch = line.match(/className="([^"]+)"/);
    if (classMatch) {
      const cls = classMatch[1];
      const w = cls.match(/(?:^|\s)w-(\d+)(?=\s|$)/);
      const h = cls.match(/(?:^|\s)h-(\d+)(?=\s|$)/);
      if (w !== null && h !== null && w[1] === h[1]) {
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'w-h-double',
          detail: `w-${w[1]} h-${h[1]}`,
        });
      }
    }
    // 硬编码 hex：仅查 className 字符串（UI 类样式）；JS 对象字面量（xterm 主题等库配置）豁免
    const classMatch2 = line.match(/className="([^"]+)"/);
    if (classMatch2 && !classMatch2[1].includes('var(--')) {
      for (const m of classMatch2[1].matchAll(HEX_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
      }
      for (const m of classMatch2[1].matchAll(RGB_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'rgb-color', detail: m[0] });
      }
    }
  });
}

function main(): number {
  const files = collectTsxFiles(SCAN_DIR);
  const violations: Violation[] = [];
  for (const file of files) checkFile(file, violations);

  if (violations.length === 0) {
    console.log(`[check-tokens] ✅ 通过：${files.length} 个文件，0 违规`);
    return 0;
  }

  console.error(
    `[check-tokens] ❌ ${violations.length} 处违规（铁律①裸色/②dark:/④space-*/⑤w+h/hex）：`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
  }
  console.error(
    '[check-tokens] 修复指引：docs/design/10-component-design-spec.md 样式铁律 + DESIGN.md',
  );
  return 1;
}

process.exitCode = main();
