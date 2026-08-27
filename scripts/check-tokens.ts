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

// 裸色类模式：bg-red-500 / text-blue-600 / border-amber-200 等（带数字后缀）
// 前缀 (?:^|\s|")：className 首位类名紧贴引号也必须命中（此前漏检）
const BARE_COLOR_RE = new RegExp(
  `(?:^|\\s|")(bg|text|border|ring|from|to|via|divide|outline|fill|stroke|shadow)-(${COLOR_PALETTE.filter((c) => c !== 'white' && c !== 'black').join('|')})-[0-9]+`,
  'g',
);

// 无阶裸色：bg-white / text-black（白/黑无数字后缀，需独立模式；此前漏检）
const BARE_MONO_RE = /(?:^|\s|")(bg|text|border|ring|shadow)-(white|black)(?=[\s"'/:\][]|$)/g;

// 存量豁免基线（白/黑裸色历史用法，新增违规仍卡关；重构为语义令牌后移除）：
//   badge.tsx = shadcn 官方 destructive 变体；browser-pane = iframe 白底；
//   inline-approval-card / DialogHost = 语义色背景上的白字（对比度需求）
const MONO_EXEMPT_FILES = new Set([
  'src/renderer/components/ui/badge.tsx',
  'src/renderer/components/dev/browser-pane.tsx',
  'src/renderer/components/agent/inline-approval-card.tsx',
  'src/renderer/components/common/DialogHost.tsx',
]);

// 手动 dark: 双写
const DARK_OVERRIDE_RE = /(?:^|\s|")dark:[a-z-]+/g;

// space-x/y
const SPACE_UTIL_RE = /(?:^|\s|")space-[xy]-[0-9.]+/g;

// className 中的硬编码 hex 颜色
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

// className 中的硬编码 rgba()/rgb() 颜色（此前只查 #hex，rgba 色会漏网）
const RGB_COLOR_RE = /rgba?\([^\n)]*\)/g;

// 裸 z-* 数字层级（收口到 --z-* 令牌体系）：z-10/z-50/z-[100] 及 hover:/focus: 变体均违例；
// z-(--z-popover) 等变量引用形式放行（Tailwind v4 圆括号语法）
const BARE_Z_RE = /(?:^|\s|")((?:[a-z-]+:)*)z-(\[?-?\d+)/g;

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

/** 类名形态判定：含至少一个工具类词根（覆盖多行 cn( 续行的类名字符串，
 * 同时避免把 i18n key/查询 key 等非样式字符串误当类名扫描） */
const CLASS_LIKE_RE =
  /\b(bg|text|border|ring|shadow|outline|fill|stroke|from|to|via|divide|rounded|flex|grid|block|hidden|absolute|relative|fixed|sticky|items|justify|gap|space|size|w|h|p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|z|top|left|right|bottom|inset|min-w|max-w|min-h|max-h|font|tracking|leading|overflow|whitespace|cursor|select|opacity|transition|animate|data|dark|hover|focus|active|disabled)[-\][:]/;

/** 提取本行候选类名字符串：静态 className="..." + 本行全部类名形态引号串（含多行 cn( 续行） */
function extractClassStrings(line: string): string[] {
  const results: string[] = [];
  const staticMatch = line.match(/className="([^"]+)"/);
  if (staticMatch !== null) results.push(staticMatch[1] as string);
  for (const m of line.matchAll(/['"]([^'"`\n]+)['"]/g)) {
    const s = m[1] as string;
    if (s === staticMatch?.[1]) continue;
    if (CLASS_LIKE_RE.test(s)) results.push(s);
  }
  return results;
}

function checkFile(file: string, violations: Violation[]): void {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;

    for (const cls of extractClassStrings(line)) {
      for (const m of cls.matchAll(BARE_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'bare-color', detail: m[0].trim() });
      }
      if (!MONO_EXEMPT_FILES.has(rel)) {
        for (const m of cls.matchAll(BARE_MONO_RE)) {
          violations.push({ file: rel, line: lineNo, rule: 'bare-color', detail: m[0].trim() });
        }
      }
      for (const m of cls.matchAll(DARK_OVERRIDE_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'dark-override', detail: m[0].trim() });
      }
      for (const m of cls.matchAll(SPACE_UTIL_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'space-util', detail: m[0].trim() });
      }
      // 仅当 className 字符串中出现 w-N 与 h-N 且数值相等（size-N 语义）
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
      // 硬编码颜色：先剔除 var(--…) 片段再查（豁免收窄到片段级，此前整行豁免会漏检）
      const withoutVars = cls.replace(/var\(--[^)]*\)/g, '');
      for (const m of withoutVars.matchAll(HEX_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
      }
      for (const m of withoutVars.matchAll(RGB_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'rgb-color', detail: m[0] });
      }
      // z 层级收口：浮层一律引用 --z-* 令牌（见 aurora.json z-* 条目），禁裸数字
      for (const m of cls.matchAll(BARE_Z_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'bare-z-index', detail: m[0].trim() });
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
