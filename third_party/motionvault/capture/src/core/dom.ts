/**
 * dom.ts —— DOM 摘要与 computed style 白名单。
 * 纯函数、无副作用（clone 后操作，不触碰原 DOM）。
 */
import type { TargetSummary } from './types';

/** camelCase 输出键 → CSS 属性名 */
const COMPUTED_WHITELIST: ReadonlyArray<readonly [string, string]> = [
  ['fontFamily', 'font-family'],
  ['fontSize', 'font-size'],
  ['fontWeight', 'font-weight'],
  ['color', 'color'],
  ['backgroundColor', 'background-color'],
  ['backgroundImage', 'background-image'],
  ['borderRadius', 'border-radius'],
  ['width', 'width'],
  ['height', 'height'],
  ['letterSpacing', 'letter-spacing'],
  ['lineHeight', 'line-height'],
  ['boxShadow', 'box-shadow'],
  ['filter', 'filter'],
  ['backdropFilter', 'backdrop-filter'],
  ['transform', 'transform'],
  ['opacity', 'opacity'],
  ['display', 'display'],
  ['position', 'position'],
  ['overflow', 'overflow'],
];

/** 目标元素的关键 computed style（白名单内的上下文属性） */
export function computedBase(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const [key, prop] of COMPUTED_WHITELIST) {
    out[key] = cs.getPropertyValue(prop);
  }
  return out;
}

const STRIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
const TEXT_TRUNCATE = 60;

function pruneClone(node: Element, depth: number, maxDepth: number): void {
  // 剥离 on* / data-* 属性
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name;
    if (name.startsWith('on') || name.startsWith('data-')) {
      node.removeAttribute(name);
    }
  }
  // 截断直接文本子节点
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const text = child.textContent ?? '';
      if (text.length > TEXT_TRUNCATE) {
        child.textContent = text.slice(0, TEXT_TRUNCATE) + '…';
      }
    }
  }
  // 递归处理子元素
  for (const child of Array.from(node.children)) {
    if (STRIP_TAGS.has(child.tagName)) {
      child.remove();
      continue;
    }
    if (depth + 1 >= maxDepth) {
      // 超出深度：保留元素外壳（tag/属性），内容折叠为省略号
      if (child.childNodes.length > 0) {
        child.textContent = '…';
      }
      continue;
    }
    pruneClone(child, depth + 1, maxDepth);
  }
}

/** 目标 DOM 片段：clone 后去 script/style/noscript、on- 前缀与 data- 前缀属性，限深、限长 */
export function domSnippet(el: Element, maxDepth = 3, maxLen = 4096): string {
  const clone = el.cloneNode(true) as Element;
  pruneClone(clone, 0, maxDepth);
  let html = clone.outerHTML;
  if (html.length > maxLen) {
    html = html.slice(0, maxLen) + '…';
  }
  return html;
}

/** 目标元素摘要（tag/classes/id/文本片段/role/子元素数） */
export function targetSummary(el: Element): TargetSummary {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const role = el.getAttribute('role');
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    ...(el.id ? { id: el.id } : {}),
    ...(text ? { textSnippet: text.slice(0, 80) } : {}),
    ...(role ? { role } : {}),
    childCount: el.children.length,
  };
}
