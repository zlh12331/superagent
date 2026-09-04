/**
 * extract.ts —— getAnimations 结果 → 结构化 CapturedAnimation。
 * 纯函数（不读 document/window），可在无真实页面的测试环境运行。
 */
import type { CapturedAnimation, CapturedKeyframe, CapturedTiming, TriggerKind } from './types';
import { targetSummary } from './dom';

type StructSource = 'css' | 'transition' | 'waapi';

/**
 * 来源判定。instanceof 在跨 realm（iframe/其它 window 的动画对象）下会失败，
 * 因此 fallback 到 CSSAnimation/CSSTransition 特有属性的鸭子检测。
 */
function sourceOf(a: Animation): { source: StructSource; name?: string } {
  const asCss = a as CSSAnimation;
  const isCss =
    (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) ||
    asCss.animationName !== undefined;
  if (isCss) return { source: 'css', name: asCss.animationName };

  const asTr = a as CSSTransition;
  const isTransition =
    (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) ||
    asTr.transitionProperty !== undefined;
  if (isTransition) return { source: 'transition' };

  return { source: 'waapi' };
}

/** getKeyframes() 帧对象上的元字段（其余属性原样保留） */
const KEYFRAME_META = new Set(['offset', 'easing', 'composite', 'computedOffset']);

function toCapturedKeyframe(kf: ComputedKeyframe): CapturedKeyframe {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(kf)) {
    if (KEYFRAME_META.has(k) || v === undefined || v === null) continue;
    props[k] = typeof v === 'string' ? v : String(v);
  }
  // computedOffset 优先（合成后 offset 可能为 null / 'auto'）
  const rawOffset = kf.computedOffset ?? kf.offset;
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : null;
  const out: CapturedKeyframe = { offset, props };
  if (typeof kf.easing === 'string') out.easing = kf.easing;
  return out;
}

function toCapturedTiming(t: ComputedEffectTiming, frameEasings: string[]): CapturedTiming {
  // duration 可能是 'auto' 或 NaN，兜底 0
  const raw = t.duration;
  const duration = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;

  // easing：整体优先；整体为 'linear'（CSS 默认）而帧级有更具体 easing 时以帧级为准
  let easing = typeof t.easing === 'string' ? t.easing : undefined;
  if ((!easing || easing === 'linear') && frameEasings.length > 0) {
    easing = frameEasings[0];
  }

  const iterations = typeof t.iterations === 'number' ? t.iterations : 1;
  return {
    duration,
    delay: typeof t.delay === 'number' && Number.isFinite(t.delay) ? t.delay : 0,
    iterations,
    ...(t.direction ? { direction: String(t.direction) } : {}),
    ...(t.fill ? { fill: String(t.fill) } : {}),
    ...(easing ? { easing } : {}),
  };
}

/** 单级选择器片段：tag#id / tag.class（必要时 :nth-of-type） */
function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  let s = tag;
  const classes = Array.from(el.classList).slice(0, 3);
  if (classes.length > 0) s += '.' + classes.join('.');
  const parent = el.parentElement;
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (sameTag.length > 1) {
      s += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return s;
}

/** 简短选择器路径：向上最多 5 级到 body，遇 id 提前截断 */
function targetPathFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.tagName !== 'BODY' && depth < 5) {
    parts.unshift(segment(cur));
    if (cur.id) break;
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

/** 只提取与 root 相关（自身/后代/祖先）的动画，与 trigger.ts 的相关性口径一致 */
function isRelevant(root: Element, el: Element): boolean {
  return el === root || root.contains(el) || el.contains(root);
}

let counter = 0;

export function extractAnimations(
  animations: Animation[],
  root: Element,
  trigger: TriggerKind = 'unknown',
): CapturedAnimation[] {
  const out: CapturedAnimation[] = [];
  for (const a of animations) {
    const effect = a.effect as KeyframeEffect | null;
    if (!effect || typeof effect.getKeyframes !== 'function') continue;

    const target = effect.target;
    if (!target || !isRelevant(root, target)) continue;

    const { source, name } = sourceOf(a);
    const keyframes = effect.getKeyframes().map(toCapturedKeyframe);
    const timing = toCapturedTiming(
      effect.getComputedTiming(),
      keyframes.map((k) => k.easing).filter((e): e is string => typeof e === 'string' && e !== 'linear'),
    );

    // 过滤无意义动画：0 时长或单帧
    if (timing.duration === 0 || keyframes.length <= 1) continue;

    const target_ = targetSummary(target);
    // 伪元素动画：在 textSnippet 前记上 '::before' 等标记
    const pseudo = effect.pseudoElement;
    if (pseudo) {
      target_.textSnippet = pseudo + (target_.textSnippet ? ' ' + target_.textSnippet : '');
    }

    out.push({
      id: `ml-${++counter}`,
      source,
      ...(name ? { name } : {}),
      keyframes,
      timing,
      targetPath: targetPathFor(target),
      target: target_,
      trigger,
    });
  }
  return out;
}
