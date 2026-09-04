/**
 * trigger.ts —— 触发与观察窗口。
 * 启发式逻辑：
 * 1. 进入窗口先取基线（getAnimations({subtree:true})，过滤到与 el 相关的动画）；
 *    基线中就有 running → 'load'。
 * 2. 300ms 后在 el 及前两级祖先上合成 mouseenter/mouseover/mousemove/focus；
 *    之后新出现/状态变化的动画 → 'hover'。
 * 3. 若 el 初始在视口外，约 55% 窗口时 scrollIntoView；滚动后才出现的动画 → 'scroll'。
 * 4. 未交互就自发出现（hover 合成之前）的动画视为延迟加载 → 'load'；否则 'unknown'。
 * 观察结束后补发 mouseleave 并恢复滚动位置。
 */
import type { TriggerKind } from './types';

export interface ObserveResult {
  animations: Animation[];
  trigger: TriggerKind;
}

const POLL_MS = 100;
const HOVER_AT_MS = 300;
const SCROLL_AT_RATIO = 0.55;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Document.getAnimations({subtree:true}) 已进规范，但当前 lib.dom 仅 Element 版本带 options 参数。
 * 本地收窄签名调用，不自行声明全局类型。
 */
function getAllAnimations(): Animation[] {
  const fn = document.getAnimations as (options?: { subtree?: boolean }) => Animation[];
  return fn.call(document, { subtree: true });
}

/** Animation 的作用目标（KeyframeEffect 才有 target；未来其它 effect 类型安全返回 null） */
function animationTarget(a: Animation): Element | null {
  const effect = a.effect;
  if (effect && 'target' in effect) {
    return (effect as KeyframeEffect).target;
  }
  return null;
}

/** 只关心目标为 el 本身、el 的后代、或 el 祖先（hover 父级带动子级）的动画 */
function isRelevant(el: Element, a: Animation): boolean {
  const t = animationTarget(a);
  if (!t) return false;
  return t === el || el.contains(t) || t.contains(el);
}

function isInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  return r.bottom > 0 && r.right > 0 && r.top < h && r.left < w;
}

/** 在 el 及其前两级祖先上合成 hover/focus 事件（bubbles:true，模拟真实指针路径） */
function dispatchSyntheticHover(el: Element): void {
  const targets: Element[] = [el];
  let cur = el.parentElement;
  for (let i = 0; i < 2 && cur; i++) {
    targets.push(cur);
    cur = cur.parentElement;
  }
  for (const t of targets) {
    t.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    t.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  }
}

export async function observeTriggers(el: Element, observeMs = 2600): Promise<ObserveResult> {
  // ---- 基线 ----
  const seen = new Map<Animation, AnimationPlayState>();
  for (const a of getAllAnimations()) {
    if (isRelevant(el, a)) seen.set(a, a.playState);
  }
  const baselineRunning: Animation[] = [];
  for (const [a, state] of seen) {
    if (state === 'running') baselineRunning.push(a);
  }

  const initiallyVisible = isInViewport(el);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // 新出现动画的首次观测时间（用于区分 hover/scroll 阶段）
  const freshAt = new Map<Animation, number>();
  const changed = new Set<Animation>();
  let hoverAt = -1;
  let scrollAt = -1;

  const sweep = (now: number, start: number): void => {
    for (const a of getAllAnimations()) {
      if (!isRelevant(el, a)) continue;
      const prev = seen.get(a);
      if (prev === undefined) {
        seen.set(a, a.playState);
        freshAt.set(a, now - start);
      } else if (prev !== a.playState) {
        seen.set(a, a.playState);
        changed.add(a);
      }
    }
  };

  // ---- 观察窗口 ----
  const start = Date.now();
  const scrollAtMs = Math.max(HOVER_AT_MS + POLL_MS, observeMs * SCROLL_AT_RATIO);
  while (Date.now() - start < observeMs) {
    const elapsed = Date.now() - start;
    if (hoverAt < 0 && elapsed >= HOVER_AT_MS) {
      dispatchSyntheticHover(el);
      hoverAt = elapsed;
    }
    if (scrollAt < 0 && !initiallyVisible && elapsed >= scrollAtMs) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      scrollAt = Date.now() - start;
    }
    sweep(Date.now(), start);
    await sleep(POLL_MS);
  }
  sweep(Date.now(), start); // 收尾补一轮，避免漏掉窗口末尾的变化

  // ---- 恢复页面状态 ----
  el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  if (scrollAt >= 0) {
    window.scrollTo(scrollX, scrollY);
  }

  // ---- trigger 判定 ----
  const fresh = [...freshAt.keys()];
  const afterHover = hoverAt >= 0 ? fresh.filter((a) => (freshAt.get(a) ?? 0) >= hoverAt) : [];
  const afterScroll = scrollAt >= 0
    ? afterHover.filter((a) => (freshAt.get(a) ?? 0) >= scrollAt)
    : [];

  let trigger: TriggerKind;
  if (baselineRunning.length > 0) {
    trigger = 'load';
  } else if (afterScroll.length > 0) {
    trigger = 'scroll';
  } else if (afterHover.length > 0 || changed.size > 0) {
    trigger = 'hover';
  } else if (fresh.length > 0) {
    // 未发生任何合成交互就自发出现 → 延迟的加载动画
    trigger = 'load';
  } else {
    trigger = 'unknown';
  }

  // ---- 汇总：基线 running + 新出现 + 状态变化（去重）----
  const collected = new Set<Animation>([...baselineRunning, ...fresh, ...changed]);
  return { animations: [...collected], trigger };
}
