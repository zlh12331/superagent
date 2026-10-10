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
