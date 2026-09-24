// scripts/lib/token-rules.ts
// 设计令牌规则核（纯函数层，供 check-tokens.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 从 check-tokens.ts 抽出的原因：门禁判据此前内联零测试（外部审计点名）。
// 反例 fixture 测试见 token-rules.test.ts——每条铁律都有「最小违规样本必须
// 命中 + 干净样本必须放过」的双向断言。
//
// 覆盖铁律（docs/design/10-component-design-spec.md）：
//   ① 裸色值（bare-color，含白/黑无阶形态，白/黑可按文件豁免）
//   ② 手动 dark: 双写（dark-override）
//   ④ space-x/y（space-util）
//   ⑤ w-N h-N 双写（w-h-double）
//   硬编码 hex/rgb（hex-color / rgb-color；var(--x) 片段级豁免）
//   裸 z-* 数字（bare-z-index）
// ──────────────────────────────────────────────────────────────

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

/** 单条令牌违规 */
export interface TokenViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
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

/**
 * 扫描 .ts/.tsx 内容：className 类规则逐条判定
 *
 * @param content 文件内容
 * @param rel 展示用相对路径（违规定位）
 * @param monoExempt 白/黑无阶裸色豁免（存量基线文件，如 badge.tsx）
 */
export function scanTsLike(content: string, rel: string, monoExempt = false): TokenViolation[] {
  const violations: TokenViolation[] = [];
  content.split('\n').forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;

    for (const cls of extractClassStrings(line)) {
      for (const m of cls.matchAll(BARE_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'bare-color', detail: m[0].trim() });
      }
      if (!monoExempt) {
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
  return violations;
}

/**
 * 扫描 css 内容：只查硬编码 hex（className 类规则对 css 无意义）。
 * 剔除块注释（含跨行）与行内 /* … *\/ 注释片段、var(--…) 片段后再查。
 * 边界（如实记录）：css 的 rgba(…) 带 alpha 效果色暂不收口（debt.md#d7）。
 */
export function scanCss(content: string, rel: string): TokenViolation[] {
  const violations: TokenViolation[] = [];
  let inBlockComment = false;
  content.split('\n').forEach((raw, idx) => {
    let line = raw;
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      return;
    }
    // 行内 /* … */ 注释片段剔除（尾注释中的色值属文档说明，非生效样式）
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    if (line.trim().startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      return;
    }
    // 先剔除 var(--…) 片段再查（豁免收窄到片段级）
    const withoutVars = line.replace(/var\(--[^)]*\)/g, '');
    const lineNo = idx + 1;
    for (const m of withoutVars.matchAll(HEX_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
    }
  });
  return violations;
}
