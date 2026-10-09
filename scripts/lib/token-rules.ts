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

// className 中的硬编码 rgba()/rgb() 颜色（此前只查 #hex，rgba 色会漏网）；
// css 分支（scanCss）复用同一正则——D7 收口后 css 效果层统一 color-mix 形态，
// 生成物 tokens.css 由 CLI 层文件豁免，其 rgba 令牌值不受影响
const RGB_COLOR_RE = /rgba?\([^\n)]*\)/g;

// 裸 z-* 数字层级（收口到 --z-* 令牌体系）：z-10/z-50/z-[100] 及 hover:/focus: 变体均违例；
// z-(--z-popover) 等变量引用形式放行（Tailwind v4 圆括号语法）
const BARE_Z_RE = /(?:^|\s|")((?:[a-z-]+:)*)z-(\[?-?\d+)/g;

// TSX 任意值字号（text-[Npx]）：绕过 --font-size-* 九级阶梯与 @theme 映射的
// text-2xs…text-3xl 命名类——字号轴的单一真源是 aurora.json，任意值 px 双开第二源
const BARE_FONT_RE = /(?:^|\s|")text-\[\d+(?:\.\d+)?px\]/g;

// CSS 侧字号字面量：font-size: 10px 这类裸 px 绕过 --font-size-* 令牌
// （var() 引用经 withoutVars 剥离后自然放行；em/% 形式是跟随父级的合法设计，不匹配）
const CSS_FONT_SIZE_RE = /font-size:\s*[0-9.]+px\b/g;

// CSS 侧裸 z-index 数字：tokens.css:9 明文禁止（此前只扫 TSX 类名串，CSS 侧免检——
// 实测曾漏过 file-tree.css 的 z-index: 9999 越过 --z-boundary: 999 无任何拦截）
const CSS_Z_INDEX_RE = /z-index:\s*-?\d+/g;

// CSS 侧文字层纪律：语义基色（--error/--success/--warning/--amber）只承担
// 图形/边框/氛围，禁止作 color: 文字色——基色压浅灰面 2.2-3.9:1 全部低于 AA 4.5，
// 文字必须用对应的 *-text 深色层（2026-10-02 审查实测 12 处违规后立规）。
// accent/accent-2 不入规则：作文字色在页面底达标（6.7:1），静态扫描无法按所在
// 底色分诊，误报不可接受；TSX 侧 text-error 等类不扫：现存均为图标用法（≥3:1
// 达标），图标/文字无法从类名区分。
const CSS_TEXT_BASE_COLOR_RE = /(?:^|[;{\s])color:\s*var\(--(error|success|warning|amber)\)/g;

// ── 字体栈 CJK 回退不变量（2026-10-09 立规）─────────────────────────────
// 硬编码 font-family / fontFamily 必须引用 var(--font-*) 令牌或自带 CJK 回退
// 字体：缺回退时中文掉到平台兜底（Windows mono 上下文 = SimSun 宋体，小字
// ClearType 下发灰发绿——file-tree 与 xterm 终端先后实测）。白名单不含 SimSun：
// 它是本不变量要防的失败形态本身。
const CJK_FONT_OK_RE =
  /PingFang|Hiragino|YaHei|Noto (?:Sans|Serif) SC|Noto Sans CJK|Noto Serif CJK|Source Han|WenQuanYi|SimHei|Songti|Heiti|STHeiti|STSong|微软雅黑/;

// TS 侧 fontFamily 字面量（内联样式对象 / JSX 属性）：值可为含另一引号形态的串
// （如 xterm 的 '…"JetBrains Mono"…'），按定界符三分支捕获；跨行值不匹配
const TS_FONT_FAMILY_RE = /fontFamily\s*[:=]\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g;

// CSS 侧 font-family 声明：值整段捕获（引号在 CSS 值内合法），var(--font-*) 引用放行
const CSS_FONT_FAMILY_RE = /font-family\s*:\s*([^;{}]+)[;}]?/g;

// CSS 侧 font: 简写（font: <style> <weight> <size>/<line-height> <family>）——家族在
// 尾段，整值判 CJK/var 即可（任一 CJK 字体在场即放行）；font-size:/font-family: 等
// 复合属性名不含 "font:" 字面（"font-" 后非冒号），不会误匹配
const CSS_FONT_SHORTHAND_RE = /(?:^|[;{\s])font:\s*([^;{}]+)[;}]?/g;

// TSX 侧任意值字体（font-[family-name:…]）：绕过 @theme 映射的第二源，var() 引用
// 放行——对称 text-[Npx] 的 font-size-literal 先例；现行仓库零使用，预防性收口
const FONT_FAMILY_ARB_RE = /(?:^|\s|")font-\[family-name:(?!var\()[^\]]*\]/g;

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
      // 字号轴收口：任意值 px 绕过 --font-size-* 阶梯与 text-2xs…text-3xl 命名类
      for (const m of cls.matchAll(BARE_FONT_RE)) {
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'font-size-literal',
          detail: m[0].trim(),
        });
      }
      // 任意值字体（font-[family-name:…]）：绕过 @theme 映射的第二源（var() 引用放行）
      for (const m of cls.matchAll(FONT_FAMILY_ARB_RE)) {
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'font-family-arbitrary',
          detail: m[0].trim(),
        });
      }
    }

    // 字体栈 CJK 回退不变量：fontFamily 字面量必须含 CJK 字体或 var() 令牌引用
    // （xterm 等 API 需要 CSS font-family 字符串，不经 className 扫描）
    for (const m of line.matchAll(TS_FONT_FAMILY_RE)) {
      const value = (m[1] ?? m[2] ?? m[3] ?? '') as string;
      if (value.includes('var(--font-') || CJK_FONT_OK_RE.test(value)) continue;
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'font-cjk-fallback',
        detail: m[0].trim().slice(0, 90),
      });
    }
  });
  return violations;
}

/**
 * 扫描 css 内容：查硬编码 hex 与 rgba()/rgb()（className 类规则对 css 无意义）、
 * 字号/层级字面量（font-size-literal / css-z-index-literal）与文字层纪律
 * （text-base-color——看 var() 令牌名，须在剥离 var 片段之前对原始行匹配）。
 * 剔除块注释（含跨行）与行内 /* … *\/ 注释片段、var(--…) 片段后再查。
 * D7 收口后效果层统一 color-mix(in srgb, <token|white|black> N%, transparent) 形态
 * （color-mix( 不匹配 rgba?\( 正则，不会误报）。
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
    // 先剔除 var(--…) 片段再查（豁免收口到片段级）
    const withoutVars = line.replace(/var\(--[^)]*\)/g, '');
    const lineNo = idx + 1;
    for (const m of withoutVars.matchAll(HEX_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
    }
    for (const m of withoutVars.matchAll(RGB_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'rgb-color', detail: m[0] });
    }
    // 字号轴收口（CSS 侧）：裸 px 绕过 --font-size-* 令牌（var 引用经剥离后放行）
    for (const m of withoutVars.matchAll(CSS_FONT_SIZE_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'font-size-literal', detail: m[0].trim() });
    }
    // z 层级收口（CSS 侧）：此前只扫 TSX，CSS 的 z-index: 9999 曾静默越界
    for (const m of withoutVars.matchAll(CSS_Z_INDEX_RE)) {
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'css-z-index-literal',
        detail: m[0].trim(),
      });
    }
    // 文字层纪律：匹配原始行而非 withoutVars——本规则要看的正是 var() 里的令牌名；
    // 边界锚 (?:^|[;{\s]) 保证 background-color / caret-color 等复合属性不误报
    for (const m of line.matchAll(CSS_TEXT_BASE_COLOR_RE)) {
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'text-base-color',
        detail: m[0].trim(),
      });
    }
    // 字体栈 CJK 回退不变量（CSS 侧）：值须引用 var(--font-*) 或自带 CJK 回退；
    // inherit/initial 跟随父级放行。值为空（跨行声明）无法按行判定，放行——
    // 当前仓库无此形态（误报不可接受，见 text-base-color 同款取舍）
    for (const m of line.matchAll(CSS_FONT_FAMILY_RE)) {
      const value = (m[1] as string).trim();
      if (
        value === '' ||
        value === 'inherit' ||
        value === 'initial' ||
        value.includes('var(--font-') ||
        CJK_FONT_OK_RE.test(value)
      ) {
        continue;
      }
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'font-cjk-fallback',
        detail: `font-family: ${value.slice(0, 70)}`,
      });
    }
    // 字体栈 CJK 回退不变量（font: 简写）：家族在尾段，整值判 CJK/var；
    // inherit 与 CSS 系统字体关键字（caption/menu/icon 等）放行
    for (const m of line.matchAll(CSS_FONT_SHORTHAND_RE)) {
      const value = (m[1] as string).trim();
      if (
        value === '' ||
        value === 'inherit' ||
        value === 'initial' ||
        value.includes('var(--font-') ||
        CJK_FONT_OK_RE.test(value) ||
        /^(caption|icon|menu|message-box|small-caption|status-bar)\b/.test(value)
      ) {
        continue;
      }
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'font-cjk-fallback',
        detail: `font: ${value.slice(0, 70)}`,
      });
    }
  });
  return violations;
}
