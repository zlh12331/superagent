// scripts/lib/i18n-hardcoded-scan.ts
// 硬编码中文扫描核（AST 版，供 check-i18n.ts CLI 调用）+ 正则渐进兜底
// ──────────────────────────────────────────────────────────────
// 修复的盲区（对照旧实现 collectHardcodedZhText 的逐行正则）：
// 1. 多行 JSX 文本节点：旧正则 `>…中文…<` 只匹配单行，跨行文本静默漏扫；
// 2. 字符串字面量属性：`<X title="中文" />` 旧实现完全无匹配；
// 3. 表达式容器：`{cond ? '是' : '否'}` 旧实现因含 `{}` 被显式排除。
//
// 判据（oxc-parser AST，随 knip 在依赖图中，devDependencies 显式声明）：
// - JSXText 节点含中文 → 'jsx-text'；
// - JSXAttribute 的字符串字面量值含中文 → 'attribute'；
// - JSXExpressionContainer 内的字符串字面量 / 模板串含中文 → 'expression'。
// 非 JSX 上下文的字符串字面量（工具函数内的 toast 文案等）不在本扫描域——
// 它们属「工具 output 内文案」的后续迁移范围，且逐行正则时代也未纳入。
//
// 兜底：AST 解析失败（语法错误/解析器版本差异）时退回逐行正则——多行文本按
// 「行内含中文且行不属于属性/标签边界」的宽松口径，属性用 `="…中文…"` 形态匹配。
// 兜底路径与 AST 路径判据不同是显式取舍：宁误报不漏扫（硬编码文案是漏报代价
// 高的方向性错误）。
// ──────────────────────────────────────────────────────────────

import { parseSync } from 'oxc-parser';

/** 单条命中：1-based 行号 + 命中类别 + 截断片段 */
export interface HardcodedZhHit {
  readonly line: number;
  readonly kind: 'jsx-text' | 'attribute' | 'expression';
  readonly snippet: string;
}

/** 中文（BMP 范围，不依赖 unicode property escape，跨运行环境更稳） */
const ZH_RE = /[\u4e00-\u9fff]/;

/** 遍历节点数上限（防异常构造的文件拖垮门禁） */
const MAX_WALK_NODES = 200_000;

/** 摘要片段：折叠空白 + 截断（与 CLI 输出口径一致） */
function snippetOf(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 60);
}

/** 依据偏移量换算 1-based 行号（行首偏移表 + 线性回退，文件规模可忽略） */
function makeLineLocator(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return (offset: number) => {
    let line = 0;
    for (const start of starts) {
      if (start <= offset) line += 1;
      else break;
    }
    return line;
  };
}

/** AST 节点最小形状（只取遍历所需字段） */
interface AstNode {
  readonly type?: string;
  readonly value?: unknown;
  readonly raw?: string;
  readonly start?: number;
  readonly quasis?: readonly { readonly value?: { readonly cooked?: string } }[];
  readonly [key: string]: unknown;
}

/** 遍历回调：node 处于以 stack（含自身）为祖先链的上下文中 */
type VisitFn = (node: AstNode, stack: readonly string[]) => void;

/** 深度优先遍历 AST；无 type 的容器对象（quasis.value 等）沿用父栈继续下钻 */
function walkAst(node: unknown, visit: VisitFn, state: { count: number }, stack: string[]): void {
  if (state.count > MAX_WALK_NODES) return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit, state, stack);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as AstNode;
  const nextStack = typeof record.type === 'string' ? [...stack, record.type] : stack;
  if (typeof record.type === 'string') {
    state.count += 1;
    visit(record, nextStack);
  }
  for (const key of Object.keys(record)) {
    if (key === 'start' || key === 'end' || key === 'range') continue;
    walkAst(record[key], visit, state, nextStack);
  }
}

/** 判断祖先链（含自身）是否触及给定类型 */
function hasContext(stack: readonly string[], types: readonly string[]): boolean {
  return stack.some((t) => types.includes(t));
}

/**
 * AST 主路径：扫描 tsx 源码中的硬编码中文（JSX 文本 / 属性字面量 / 表达式容器）。
 *
 * @param content tsx 文件完整内容
 * @returns 命中列表（行号升序）；解析失败返回 null（调用方走正则兜底）
 */
export function scanHardcodedZhByAst(content: string): HardcodedZhHit[] | null {
  let program: unknown;
  try {
    const parsed = parseSync('virtual.tsx', content);
    if (parsed.errors.length > 0) return null;
    program = parsed.program;
  } catch {
    return null;
  }

  const hits: HardcodedZhHit[] = [];
  const lineAt = makeLineLocator(content);
  const state = { count: 0 };

  walkAst(
    program,
    (node, stack) => {
      const type = node.type ?? '';
      if (type === 'JSXText' && typeof node.value === 'string' && ZH_RE.test(node.value)) {
        hits.push({
          line: lineAt(node.start ?? 0),
          kind: 'jsx-text',
          snippet: snippetOf(node.value),
        });
        return;
      }
      if (type !== 'Literal' && type !== 'TemplateLiteral') return;
      // 字符串字面量 / 模板串：仅 JSX 域内（属性或表达式容器）纳入；
      // 属性语境优先（`{x && <div title="中"/>}` 属属性而非表达式文案）
      const inAttribute = hasContext(stack, ['JSXAttribute']);
      const inExpression = hasContext(stack, ['JSXExpressionContainer']);
      if (!inAttribute && !inExpression) return;
      const text =
        type === 'TemplateLiteral'
          ? (node.quasis ?? []).map((q) => q.value?.cooked ?? '').join('')
          : typeof node.value === 'string'
            ? node.value
            : (node.raw ?? '');
      if (typeof text === 'string' && ZH_RE.test(text)) {
        hits.push({
          line: lineAt(node.start ?? 0),
          kind: inAttribute ? 'attribute' : 'expression',
          snippet: snippetOf(text),
        });
      }
    },
    state,
    [],
  );

  // 先序遍历天然按行序产出，按行号稳定排序防遍历顺序差异
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * 正则兜底路径：AST 解析失败时退回逐行扫描。
 *
 * 口径较 AST 路径宽松（宁误报不漏扫）：
 * - 行内 `>…中文…<` 单行文本节点形态（旧实现口径）；
 * - 属性形态 `="…中文…"`；
 * - 表达式形态 `{…'…中文…'…}`。
 * 含 `t(` 的行跳过（该行已走 i18n），注释行跳过。
 */
export function scanHardcodedZhByRegex(content: string): HardcodedZhHit[] {
  const hits: HardcodedZhHit[] = [];
  const nodeRe = />\s*[^<>{}=\r\n]*[\u4e00-\u9fff][^<>{}=\r\n]*</g;
  const attrRe = /=(["'])[^"'\r\n]*[\u4e00-\u9fff][^"'\r\n]*\1/g;
  const exprRe = /\{[^{}\r\n]*['"`][^'"`\r\n]*[\u4e00-\u9fff]/g;
  content.split('\n').forEach((line, idx) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (/\bt\(/.test(line)) return;
    const isNode = nodeRe.test(line);
    const isAttr = !isNode && attrRe.test(line);
    if (isNode || isAttr || exprRe.test(line)) {
      hits.push({
        line: idx + 1,
        kind: isNode ? 'jsx-text' : isAttr ? 'attribute' : 'expression',
        snippet: snippetOf(line),
      });
    }
  });
  return hits;
}

/** 组合入口：AST 优先，失败退正则兜底 */
export function scanHardcodedZh(content: string): HardcodedZhHit[] {
  return scanHardcodedZhByAst(content) ?? scanHardcodedZhByRegex(content);
}
