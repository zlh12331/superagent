/** 单个函数的度量结果 */
export interface FnMetric {
  readonly name: string;
  readonly line: number;
  /** 形参个数（解构对象算 1 个——它正是「对象封装」的合规写法） */
  readonly params: number;
  /** 首个形参是否为解构形态（仅用于报告，不再作为豁免依据） */
  readonly destructured: boolean;
}

/**
 * 函数签名正则：function 声明 / 箭头函数 / const f = function 三形态
 *
 * 箭头分支的形参区有界（最多一层嵌套括号）且允许显式返回类型标注：
 * 两者缺一都会让惰性组跨行吞到下文最近的 `) =>`，产出 params 失真。
 */
const FN_RE =
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*(?::[^{}]*)?(?=\s*\{)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(((?:[^()]|\([^()]*\))*)\)|(\w+))\s*(?::(?:[^(){};=]|\((?:[^()]|\([^()]*\))*\))*)?=>|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(([\s\S]*?)\)/g;

/**
 * class 方法签名正则（2026-09-08 补覆盖）
 *
 * 此前 class 方法完全不被度量——最长的三处（AgentService.streamToWebContents
 * 约 511 行、ServiceContainer.dispose 约 199 行、SessionService.appendMessage）
 * 全部逃逸门禁，报告里 0 命中给人「函数都合规」的错觉。
 *
 * 覆盖形态：
 * - 修饰符：public/private/protected/readonly/static/abstract/override/async/get/set
 *   任意组合（如 `private async foo(...)`、`static get bar()`）
 * - 可选方法名 `#private`、计算属性跳过（正则不匹配，属漏报方向）
 * - 形参区同样有界（最多一层嵌套括号），允许显式返回类型
 * - 泛型方法 `foo<T>(...)` 由泛型段 `(?:<[^(]*>)?` 吸收
 *
 * 排除：constructor 单独计（体长同样受门禁约束，不豁免）
 */
const METHOD_RE =
  /^[ \t]+(?:(?:public|private|protected|readonly|static|abstract|override|declare|async|get|set)\s+)*([A-Za-z_$#][\w$]*|constructor)\s*(?:<[^(]*>)?\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?::(?:[^(){};=]|\((?:[^()]|\([^()]*\))*\))*)?(?=\s*\{)/gm;

/**
 * 控制流关键字（2026-09-08 修复误配）
 *
 * METHOD_RE 按「缩进 + 标识符 + 形参区 + {」匹配，`if (x) {` / `for (…) {`
 * 这类语句形态完全符合，会被误当方法（曾产出 `if#5 body=67` 的幽灵条目）。
 * 这些关键字不是方法名，显式排除。
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'do',
  'else',
  'with',
]);

/** 剔除泛型内容（支持多层嵌套）：防 Map<string, number> 的逗号被误计为参数分隔 */
export function stripGenerics(text: string): string {
  let prev = '';
  let cur = text;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/<[^<>]*>/g, '');
  }
  return cur;
}

/**
 * 顶层逗号切分（深度感知：() [] {} 内部不切）
 *
 * @param text 参数区原文（不含外层括号）
 * @returns 每个形参的原始片段
 */
export function splitTopLevelParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter((seg) => seg.trim() !== '');
}

/**
 * 计算形参个数（解构参数不再整函数豁免，而是按 1 个参数计）
 *
 * @param paramsText 括号内的参数原文（可跨行）
 * @returns count + destructured 标记
 */
export function countParams(paramsText: string): { count: number; destructured: boolean } {
  const cleaned = stripGenerics(paramsText);
  const segments = splitTopLevelParams(cleaned);
  const destructured = /^\s*[{[]/.test(segments[0] ?? '');
  return { count: segments.length, destructured };
}

/**
 * 扫描单文件源码中的全部函数并给出形参度量
 *
 * @param source 全文
 * @returns 度量列表（按出现顺序；注释行内的伪签名已过滤）
 */
export function scanFunctions(source: string): FnMetric[] {
  const lines = source.split('\n');
  const out: FnMetric[] = [];
  const seenAt = new Set<number>();
  for (const match of source.matchAll(FN_RE)) {
    const index = match.index ?? 0;
    const name = match[1] ?? match[3] ?? match[6] ?? 'anonymous';
    const paramsText = match[2] ?? match[4] ?? match[7];
    const bareParam = match[5];
    if (paramsText === undefined && bareParam === undefined) continue;
    const line = source.slice(0, index).split('\n').length;
    const lineText = (lines[line - 1] ?? '').trim();
    if (lineText.startsWith('//') || lineText.startsWith('*') || lineText.startsWith('/*'))
      continue;

    const counted =
      bareParam !== undefined
        ? { count: 1, destructured: false }
        : countParams(paramsText as string);
    out.push({ name, line, params: counted.count, destructured: counted.destructured });
    seenAt.add(index);
  }

  for (const match of source.matchAll(METHOD_RE)) {
    const index = match.index ?? 0;
    if (seenAt.has(index)) continue;
    const name = match[1] ?? 'method';
    if (CONTROL_FLOW_KEYWORDS.has(name)) continue;
    const paramsText = match[2] ?? '';
    const line = source.slice(0, index).split('\n').length;
    const lineText = (lines[line - 1] ?? '').trim();
    if (lineText.startsWith('//') || lineText.startsWith('*') || lineText.startsWith('/*'))
      continue;

    const counted = countParams(paramsText);
    out.push({ name, line, params: counted.count, destructured: counted.destructured });
  }
  return out;
}
