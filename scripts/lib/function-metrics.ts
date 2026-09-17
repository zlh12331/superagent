// scripts/lib/function-metrics.ts
// 函数度量纯函数：形参计数（2026-09-15 起仅存此职——函数体行数已迁移 Biome）
// ──────────────────────────────────────────────────────────────
// 2026-09-15 体长度量退役（用户拍板）：函数体行数改由 Biome 内置规则
// noExcessiveLinesPerFunction 度量（scripts/check-functions.ts 从其 JSON 诊断读取）。
// 本模块曾以正则启发式同时度量形参与体长，其「已知边界」（对象字面量返回类型、
// 多层嵌套形参括号、嵌套模板串的漏报；花括号深度扫描的手写词法歧义）中体长相关
// 部分随迁移消失；形参相关边界（多层嵌套形参括号漏报）仍在。
// 迁移方向记录：若形参度量也要迁移，Biome 无 max-params 规则，届时评估 oxc-parser。
// ──────────────────────────────────────────────────────────────
//
// 2026-08-30 修正一处**误报**：箭头函数带显式返回类型（`(p: T): R => …`）时，
// 原形参捕获 `(\(([\s\S]*?)\)\s*=>)` 无法就地闭合，惰性组会一路跑到下文最近的
// `) =>`，把两个函数之间的一段代码当成形参表——params 被逗号数放大、真实函数体
// 反而被跳过（基线里因此沉淀了 `#q params 24` 这类幽灵条目）。
// 现改为：① 形参区不跨越第二层括号；② 返回类型段顶层禁 `=`、`;`、`{}`，
// 只允许再嵌一层括号。于是签名总在**自己的** `=>` 处闭合，
// `): (() => void) => {` 也能正确定位函数体，跨行吞并从根上消除。
// ──────────────────────────────────────────────────────────────

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
    // 四种形态：function 声明(1,2)、括号箭头(3,4)、裸标识符箭头(3,5)、const = function(6,7)
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
        ? { count: 1, destructured: false } // `props => {}` 单形参
        : countParams(paramsText as string);
    out.push({ name, line, params: counted.count, destructured: counted.destructured });
    seenAt.add(index);
  }

  // class 方法（2026-09-08 补覆盖）：正则按行锚定缩进 + 修饰符前缀，
  // 与 FN_RE 的匹配位置不会重叠（方法签名不以 function/const 开头），
  // seenAt 仅作防御性去重。
  for (const match of source.matchAll(METHOD_RE)) {
    const index = match.index ?? 0;
    if (seenAt.has(index)) continue;
    const name = match[1] ?? 'method';
    // 控制流语句形态（if/for/while…）不是方法，跳过
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
