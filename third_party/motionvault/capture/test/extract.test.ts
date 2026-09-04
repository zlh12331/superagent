/**
 * extract.ts 纯函数测试。用最小 mock 构造 Animation/Element，
 * 覆盖：来源判定、keyframe 元字段剥离、timing 兜底、easing 帧级优先、
 * targetPath 生成、伪元素标记、无意义动画过滤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnimations } from '../src/core/extract';
import { targetSummary } from '../src/core/dom';
import type { CapturedKeyframe } from '../src/core/types';

interface FakeEl {
  tagName: string;
  id: string;
  classList: string[];
  children: FakeEl[];
  parentElement: FakeEl | null;
  textContent: string;
  role: string | null;
  getAttribute(name: string): string | null;
  contains(other: FakeEl): boolean;
}

function fakeEl(tag: string, opts: Partial<{
  id: string; classes: string[]; text: string; role: string;
}> = {}): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    id: opts.id ?? '',
    classList: opts.classes ?? [],
    children: [],
    parentElement: null,
    textContent: opts.text ?? '',
    role: opts.role ?? null,
    getAttribute(name: string) {
      return name === 'role' ? el.role : null;
    },
    contains(other: FakeEl): boolean {
      let cur: FakeEl | null = other;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentElement;
      }
      return false;
    },
  };
  return el;
}

function link(parent: FakeEl, ...children: FakeEl[]): FakeEl {
  parent.children = children;
  for (const c of children) c.parentElement = parent;
  return parent;
}

interface FakeAnimOpts {
  kind?: 'css' | 'transition' | 'waapi';
  name?: string;
  target: FakeEl;
  keyframes?: Array<Record<string, unknown>>;
  timing?: Record<string, unknown>;
  pseudoElement?: string | null;
}

function fakeAnimation(opts: FakeAnimOpts): Animation {
  const keyframes = opts.keyframes ?? [
    { offset: 0, computedOffset: 0, easing: 'ease-out', composite: 'replace', transform: 'translateY(0)', opacity: '0' },
    { offset: 1, computedOffset: 1, easing: 'linear', composite: 'replace', transform: 'translateY(-24px)', opacity: '1' },
  ];
  const timing = {
    duration: 400, delay: 0, iterations: 1, direction: 'normal', fill: 'both', easing: 'linear',
    ...opts.timing,
  };
  const effect = {
    target: opts.target,
    pseudoElement: opts.pseudoElement ?? null,
    getKeyframes: () => keyframes,
    getComputedTiming: () => timing,
  };
  const a: Record<string, unknown> = { effect, playState: 'running', id: '' };
  if (opts.kind === 'css') a.animationName = opts.name ?? 'slide-up';
  if (opts.kind === 'transition') a.transitionProperty = 'opacity';
  return a as unknown as Animation;
}

// 常用结构：body > section.wrap > div.card
function buildTree(): { body: FakeEl; section: FakeEl; card: FakeEl } {
  const card = fakeEl('div', { classes: ['card', 'lift'], text: '  悬浮卡片  ' });
  const section = fakeEl('section', { classes: ['wrap'] });
  const body = fakeEl('body');
  link(section, card);
  link(body, section);
  return { body, section, card };
}

test('来源判定：css / transition / waapi', () => {
  const { card } = buildTree();
  const css = extractAnimations([fakeAnimation({ kind: 'css', name: 'pop', target: card })], card as unknown as Element);
  assert.equal(css[0].source, 'css');
  assert.equal(css[0].name, 'pop');

  const tr = extractAnimations([fakeAnimation({ kind: 'transition', target: card })], card as unknown as Element);
  assert.equal(tr[0].source, 'transition');

  const wa = extractAnimations([fakeAnimation({ kind: 'waapi', target: card })], card as unknown as Element);
  assert.equal(wa[0].source, 'waapi');
  assert.equal(wa[0].name, undefined);
});

test('keyframe：剥离元字段，保留属性为字符串，offset 取 computedOffset', () => {
  const { card } = buildTree();
  const [cap] = extractAnimations([fakeAnimation({ kind: 'css', target: card })], card as unknown as Element);
  assert.equal(cap.keyframes.length, 2);
  const kf0: CapturedKeyframe = cap.keyframes[0];
  assert.equal(kf0.offset, 0);
  assert.equal(kf0.easing, 'ease-out');
  assert.deepEqual(kf0.props, { transform: 'translateY(0)', opacity: '0' });
  assert.ok(!('computedOffset' in kf0.props) && !('composite' in kf0.props) && !('easing' in kf0.props));
});

test('timing：整体 easing 为 linear 时以帧级 easing 为准', () => {
  const { card } = buildTree();
  const [cap] = extractAnimations([fakeAnimation({ kind: 'css', target: card })], card as unknown as Element);
  assert.equal(cap.timing.duration, 400);
  assert.equal(cap.timing.easing, 'ease-out');
  assert.equal(cap.timing.fill, 'both');
});

test('timing：整体 easing 非 linear 时不被帧级覆盖', () => {
  const { card } = buildTree();
  const [cap] = extractAnimations(
    [fakeAnimation({ kind: 'css', target: card, timing: { easing: 'cubic-bezier(.2,.8,.2,1)' } })],
    card as unknown as Element,
  );
  assert.equal(cap.timing.easing, 'cubic-bezier(.2,.8,.2,1)');
});

test('过滤：duration 为 auto/NaN/0 或单帧的动画被丢弃', () => {
  const { card } = buildTree();
  const res = extractAnimations([
    fakeAnimation({ kind: 'css', target: card, timing: { duration: 'auto' } }),
    fakeAnimation({ kind: 'css', target: card, timing: { duration: NaN } }),
    fakeAnimation({ kind: 'css', target: card, timing: { duration: 0 } }),
    fakeAnimation({ kind: 'css', target: card, keyframes: [{ offset: 0, computedOffset: 0, opacity: '1' }] }),
  ], card as unknown as Element);
  assert.equal(res.length, 0);
});

test('targetPath：tag.class，向上到 body；同名兄弟加 :nth-of-type', () => {
  const card = fakeEl('div', { classes: ['card'] });
  const sibling = fakeEl('div', { classes: ['plain'] });
  const section = fakeEl('section', { classes: ['wrap'] });
  const body = fakeEl('body');
  link(section, sibling, card);
  link(body, section);
  const [cap] = extractAnimations(
    [fakeAnimation({ kind: 'css', target: card })],
    card as unknown as Element,
  );
  assert.equal(cap.targetPath, 'section.wrap > div.card:nth-of-type(2)');
});

test('targetPath：遇 id 提前截断', () => {
  const inner = fakeEl('span');
  const host = fakeEl('div', { id: 'hero' });
  const body = fakeEl('body');
  link(host, inner);
  link(body, host);
  const [cap] = extractAnimations(
    [fakeAnimation({ kind: 'css', target: inner })],
    inner as unknown as Element,
  );
  assert.equal(cap.targetPath, 'div#hero > span');
});

test('伪元素：记进 targetSummary.textSnippet 前缀', () => {
  const { card } = buildTree();
  const [cap] = extractAnimations(
    [fakeAnimation({ kind: 'css', target: card, pseudoElement: '::before' })],
    card as unknown as Element,
  );
  assert.ok(cap.target.textSnippet?.startsWith('::before'));
});

test('不相关元素（与 root 无包含关系）被跳过；trigger 透传', () => {
  const { card } = buildTree();
  const lonely = fakeEl('div');
  const res = extractAnimations(
    [fakeAnimation({ kind: 'css', target: lonely })],
    card as unknown as Element,
    'hover',
  );
  assert.equal(res.length, 0);
  const ok = extractAnimations(
    [fakeAnimation({ kind: 'css', target: card })],
    card as unknown as Element,
    'hover',
  );
  assert.equal(ok[0].trigger, 'hover');
});

test('targetSummary：tag/classes/text 截断/childCount', () => {
  const child = fakeEl('b', { text: 'x' });
  const el = fakeEl('button', { classes: ['a', 'b'], text: '  点击 我  ', role: 'switch' });
  link(el, child);
  const s = targetSummary(el as unknown as Element);
  assert.equal(s.tag, 'button');
  assert.deepEqual(s.classes, ['a', 'b']);
  assert.equal(s.textSnippet, '点击 我');
  assert.equal(s.role, 'switch');
  assert.equal(s.childCount, 1);
});
