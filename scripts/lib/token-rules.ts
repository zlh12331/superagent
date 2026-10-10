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

const BARE_COLOR_RE = new RegExp(
  `(?:^|\\s|")(bg|text|border|ring|from|to|via|divide|outline|fill|stroke|shadow)-(${COLOR_PALETTE.filter((c) => c !== 'white' && c !== 'black').join('|')})-[0-9]+`,
  'g',
);

const BARE_MONO_RE = /(?:^|\s|")(bg|text|border|ring|shadow)-(white|black)(?=[\s"'/:\][]|$)/g;

const DARK_OVERRIDE_RE = /(?:^|\s|")dark:[a-z-]+/g;

const SPACE_UTIL_RE = /(?:^|\s|")space-[xy]-[0-9.]+/g;

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

const RGB_COLOR_RE = /rgba?\([^\n)]*\)/g;

const BARE_Z_RE = /(?:^|\s|")((?:[a-z-]+:)*)z-(\[?-?\d+)/g;

const BARE_FONT_RE = /(?:^|\s|")text-\[\d+(?:\.\d+)?px\]/g;

const CSS_FONT_SIZE_RE = /font-size:\s*[0-9.]+px\b/g;

const CSS_Z_INDEX_RE = /z-index:\s*-?\d+/g;

const CSS_TEXT_BASE_COLOR_RE = /(?:^|[;{\s])color:\s*var\(--(error|success|warning|amber)\)/g;

const CJK_FONT_OK_RE =
  /PingFang|Hiragino|YaHei|Noto (?:Sans|Serif) SC|Noto Sans CJK|Noto Serif CJK|Source Han|WenQuanYi|SimHei|Songti|Heiti|STHeiti|STSong|微软雅黑/;

const TS_FONT_FAMILY_RE = /fontFamily\s*[:=]\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g;

const CSS_FONT_FAMILY_RE = /font-family\s*:\s*([^;{}]+)[;}]?/g;

const CSS_FONT_SHORTHAND_RE = /(?:^|[;{\s])font:\s*([^;{}]+)[;}]?/g;

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
      const withoutVars = cls.replace(/var\(--[^)]*\)/g, '');
      for (const m of withoutVars.matchAll(HEX_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
      }
      for (const m of withoutVars.matchAll(RGB_COLOR_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'rgb-color', detail: m[0] });
      }
      for (const m of cls.matchAll(BARE_Z_RE)) {
        violations.push({ file: rel, line: lineNo, rule: 'bare-z-index', detail: m[0].trim() });
      }
      for (const m of cls.matchAll(BARE_FONT_RE)) {
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'font-size-literal',
          detail: m[0].trim(),
        });
      }
      for (const m of cls.matchAll(FONT_FAMILY_ARB_RE)) {
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'font-family-arbitrary',
          detail: m[0].trim(),
        });
      }
    }

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
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    if (line.trim().startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      return;
    }
    const withoutVars = line.replace(/var\(--[^)]*\)/g, '');
    const lineNo = idx + 1;
    for (const m of withoutVars.matchAll(HEX_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'hex-color', detail: m[0] });
    }
    for (const m of withoutVars.matchAll(RGB_COLOR_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'rgb-color', detail: m[0] });
    }
    for (const m of withoutVars.matchAll(CSS_FONT_SIZE_RE)) {
      violations.push({ file: rel, line: lineNo, rule: 'font-size-literal', detail: m[0].trim() });
    }
    for (const m of withoutVars.matchAll(CSS_Z_INDEX_RE)) {
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'css-z-index-literal',
        detail: m[0].trim(),
      });
    }
    for (const m of line.matchAll(CSS_TEXT_BASE_COLOR_RE)) {
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'text-base-color',
        detail: m[0].trim(),
      });
    }
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
