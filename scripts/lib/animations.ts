/** 单条动画引用 */
export interface AnimationRef {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

/** 扫描结果 */
export interface AnimationScan {
  /** CSS 中出现的全部 @keyframes 名 */
  readonly defined: ReadonlySet<string>;
  /** 全部引用（含已定义的，便于统计口径统一） */
  readonly refs: readonly AnimationRef[];
}

/**
 * 动画简写值里的保留关键字（非动画名的 token）
 *
 * 覆盖 animation 简写的所有组成部分：时长/延迟（数字+时间单位）、缓动函数、
 * 迭代次数、方向、填充模式、播放状态，以及全局关键字。
 */
const ANIMATION_KEYWORDS: ReadonlySet<string> = new Set([
  'none',
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'infinite',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
]);

/** 括号组折叠后的占位 token（其内部逗号/空格不参与分词） */
const FN_PLACEHOLDER = '_fn_';

/**
 * 把括号组（缓动函数 / var()）连同其函数名折叠为一个占位 token
 *
 * 必要性：`cubic-bezier(0.34, 1.56, 0.64, 1) 1s` 里的逗号是函数参数分隔符，
 * 若直接按逗号切分会被误当「多条动画」，`1)` 之类碎片再被误当动画名
 * （实测踩到，已由此函数的单测覆盖）。
 */
function collapseParenGroups(value: string): string {
  let out = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') {
      depth += 1;
      if (depth === 1) out = out.replace(/[^\s]*$/, '');
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) out += ` ${FN_PLACEHOLDER} `;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** 是否为非「动画名」的 token（时间值 / 缓动函数 / 关键字 / 占位符） */
function isNonNameToken(token: string): boolean {
  if (token.length === 0) return true;
  if (token === FN_PLACEHOLDER) return true;
  if (/^\d+(\.\d+)?(ms|s)?$/.test(token)) return true;
  if (token.includes('(') || token.includes(')')) return true;
  return ANIMATION_KEYWORDS.has(token);
}

/**
 * 解析 CSS animation 简写值，取出其中引用的动画名
 *
 * 逗号分隔多条动画；每条里第一个「非保留关键字」token 就是动画名
 * （简写允许省略部分字段，但动画名位置固定：不省略时在前段）。
 */
export function extractAnimationNamesFromValue(value: string): string[] {
  const names: string[] = [];
  for (const part of collapseParenGroups(value).split(',')) {
    for (const token of part.trim().split(/\s+/)) {
      const bare = token.replace(/;$/, '').trim();
      if (isNonNameToken(bare)) continue;
      names.push(bare);
      break;
    }
  }
  return names;
}

/**
 * 解析 Tailwind 任意值动画类：animate-[name_1s_ease…]
 *
 * 方括号内下划线是空格转义，先还原再复用简写解析（取第一个非关键字 token）。
 */
export function extractArbitraryAnimateNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/animate-\[([^\]]+)\]/g)) {
    const inner = match[1];
    if (inner === undefined) continue;
    names.push(...extractAnimationNamesFromValue(inner.replace(/_/g, ' ')));
  }
  return names;
}

/** 从 CSS 文本收集 @keyframes 定义名 */
export function extractKeyframeNames(css: string): string[] {
  const names: string[] = [];
  for (const match of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** animation 声明（含 animation-name 与 animation 简写两种写法） */
const ANIMATION_DECLARATION_RE = /animation(?:-name)?\s*:([^;]*)/g;

/**
 * 从 CSS 文本收集 animation 引用名（含行号）
 *
 * 块注释用状态机整段跳过、行内 /* … *\/ 片段先剔除再匹配：注释里常以
 * `animation: foo 1s` 举例或讨论动画行为（如 reduced-motion 的例外说明）。
 * 仅靠行首 /* 与 * 前缀的行首启发式挡不住本项目 biome 风格的无 * 前缀
 * 块注释续行——实测「animation:none 会让…」的讨论注释曾被整条误报。
 */
export function extractCssAnimationRefsWithLines(css: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  let inBlockComment = false;
  css.split(/\r?\n/).forEach((rawLine, index) => {
    let line = rawLine.trim();
    if (line.startsWith('//')) return;
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      return;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const openIdx = line.indexOf('/*');
    if (openIdx !== -1) {
      line = line.slice(0, openIdx);
      inBlockComment = true;
    }
    for (const declaration of line.matchAll(ANIMATION_DECLARATION_RE)) {
      if (declaration[1] === undefined) continue;
      for (const name of extractAnimationNamesFromValue(declaration[1])) {
        found.push({ name, line: index + 1 });
      }
    }
  });
  return found;
}

/** 从 CSS 文本收集 animation 引用名（仅名字） */
export function extractCssAnimationRefs(css: string): string[] {
  return extractCssAnimationRefsWithLines(css).map((ref) => ref.name);
}

/** 引用是否可解析到定义（未定义的即失效引用） */
export function findMissingAnimations(
  refs: readonly AnimationRef[],
  defined: ReadonlySet<string>,
): AnimationRef[] {
  return refs.filter((ref) => !defined.has(ref.name));
}
