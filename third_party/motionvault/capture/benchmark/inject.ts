/**
 * inject.ts — 跑在被测页面里的 benchmark 提取逻辑。
 * 由 run.mjs 用 esbuild 打成 IIFE 后经 page.addScriptTag 注入，暴露 window.__mlBench。
 *
 * 不使用 core 的 capture()/pickElement()（交互点选），直接编排底层函数：
 *   extractAnimations(document.getAnimations({subtree:true}), preview, trigger)
 * 兜底 sampleElement(preview, ms, {deep:true}) + fitSegments。
 *
 * 卡片定位：分类页每个效果渲染为 <article class="group ...">（见 src/components/EffectCard.tsx）。
 * 预览容器 = article 内第一个 class 含 "aspect-[" 的 div
 *   （'relative aspect-[16/10] w-full min-w-0 overflow-hidden rounded-xl ...'）。
 */
import { extractAnimations } from '../src/core/extract';
import { sampleElement } from '../src/core/sample';
import { fitSegments } from '../src/core/fit';
import type { CapturedAnimation, FittedSegment, TriggerKind } from '../src/core/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CARD_SELECTOR = 'article.group';
/** 预览容器选择器（README 有记录） */
const PREVIEW_SELECTOR = 'div[class*="aspect-["]';

export interface ScanResult {
  ok: boolean;
  reason?: string;
  title?: string;
  animations?: CapturedAnimation[];
}

export interface SampleResult {
  ok: boolean;
  reason?: string;
  channels?: string[];
  segments?: FittedSegment[];
  fps?: number;
  durationMs?: number;
}

function cards(): Element[] {
  return Array.from(document.querySelectorAll(CARD_SELECTOR));
}

function cardAt(index: number): Element | null {
  return cards()[index] ?? null;
}

function titleOf(card: Element): string {
  return card.querySelector('h3')?.textContent?.trim() ?? '';
}

function previewOf(card: Element): Element | null {
  return card.querySelector(PREVIEW_SELECTOR) ?? null;
}

/** 结构化提取：全文档 getAnimations（含 subtree），按 preview 相关性过滤 */
function collect(root: Element, trigger: TriggerKind): CapturedAnimation[] {
  const all = document.getAnimations({ subtree: true });
  return extractAnimations(all, root, trigger);
}

/** 等预览真正挂载（useInView + Suspense），最多 maxMs */
async function waitPreviewMounted(preview: Element, maxMs = 4000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) {
    // 预览组件挂载后容器内会有内容（除去常驻的「重新播放」按钮也算，直接看子节点数）
    if (preview.childElementCount > 0) return true;
    await sleep(120);
  }
  return preview.childElementCount > 0;
}

export async function scan(index: number, settleMs = 2200): Promise<ScanResult> {
  const card = cardAt(index);
  if (!card) return { ok: false, reason: 'card-not-found' };
  const title = titleOf(card);
  // 触发 useInView 挂载；instant 绕过 Lenis 平滑滚动
  card.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  await sleep(150);
  const preview = previewOf(card);
  if (!preview) return { ok: false, reason: 'preview-not-found', title };
  const mounted = await waitPreviewMounted(preview);
  if (!mounted) return { ok: false, reason: 'preview-not-mounted', title };
  await sleep(settleMs);
  try {
    const animations = collect(preview, 'load');
    return { ok: true, title, animations };
  } catch (e) {
    return { ok: false, reason: `extract-threw: ${(e as Error)?.message ?? e}`, title };
  }
}

/** 在 playwright 真实 hover（触发 :hover）期间做结构化提取 */
export async function hoverScan(index: number, waitMs = 700): Promise<ScanResult> {
  const card = cardAt(index);
  if (!card) return { ok: false, reason: 'card-not-found' };
  const preview = previewOf(card);
  if (!preview) return { ok: false, reason: 'preview-not-found', title: titleOf(card) };
  await sleep(waitMs); // 等 hover 状态/transition 起来
  try {
    const animations = collect(preview, 'hover');
    return { ok: true, title: titleOf(card), animations };
  } catch (e) {
    return { ok: false, reason: `extract-threw: ${(e as Error)?.message ?? e}`, title: titleOf(card) };
  }
}

/**
 * 重挂载扫描：点卡片自带的「重新播放」按钮（aria-label="重新播放"）让预览组件 remount，
 * 挂载型动画（mount/entrance，settle 后已播完的）重新进入 running 状态后立即收集。
 */
export async function replayScan(index: number, waitMs = 250): Promise<ScanResult> {
  const card = cardAt(index);
  if (!card) return { ok: false, reason: 'card-not-found' };
  const title = titleOf(card);
  const btn = card.querySelector('button[aria-label="重新播放"]');
  const preview = previewOf(card);
  if (!preview) return { ok: false, reason: 'preview-not-found', title };
  if (!(btn instanceof HTMLElement)) return { ok: false, reason: 'replay-button-not-found', title };
  btn.click();
  await sleep(waitMs); // 等 remount 完成、动画进入 running
  try {
    const animations = collect(preview, 'load');
    return { ok: true, title, animations };
  } catch (e) {
    return { ok: false, reason: `extract-threw: ${(e as Error)?.message ?? e}`, title };
  }
}

/** 点击后的结构化收集（真实 click 由 playwright 侧发出） */
export async function clickScan(index: number, waitMs = 350): Promise<ScanResult> {
  const card = cardAt(index);
  if (!card) return { ok: false, reason: 'card-not-found' };
  const preview = previewOf(card);
  if (!preview) return { ok: false, reason: 'preview-not-found', title: titleOf(card) };
  await sleep(waitMs);
  try {
    const animations = collect(preview, 'click');
    return { ok: true, title: titleOf(card), animations };
  } catch (e) {
    return { ok: false, reason: `extract-threw: ${(e as Error)?.message ?? e}`, title: titleOf(card) };
  }
}

/** 找 preview 内部的可滚动容器（scroll 分类的预览用内部滚动容器 .mv-scroll，而非 window） */
function innerScroller(preview: Element): Element | null {
  const named = preview.querySelector('.mv-scroll');
  if (named && named.scrollHeight > named.clientHeight + 20) return named;
  for (const el of Array.from(preview.querySelectorAll('*'))) {
    if (el.scrollHeight > el.clientHeight + 20) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
  }
  return null;
}

/**
 * 采样期间的并发刺激：
 * - 合成 mousemove/pointermove 横扫（磁吸/3D 倾斜/聚光类 pointermove 驱动）
 * - 内部滚动容器（scroll 叙事类，.mv-scroll）全程滚到底再滚回
 * - window 小幅滚动兜底（ScrollTrigger 挂在 window 上的情况）
 */
async function stimulate(preview: Element, sampleMs: number): Promise<void> {
  const rect = preview.getBoundingClientRect();
  const scroller = innerScroller(preview);
  const savedTop = scroller?.scrollTop ?? 0;
  const maxTop = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
  const y0 = window.scrollY;

  const steps = 24;
  const stepMs = sampleMs / (steps + 6);
  // 前 40%：pointer 横扫
  for (let i = 0; i < 10; i++) {
    const x = rect.left + (rect.width * i) / 9;
    const y = rect.top + rect.height * (0.3 + 0.4 * Math.abs(Math.sin(i)));
    try {
      // 事件要落在指针下方的内层元素上（onPointerMove 挂在内层卡片，dispatch 在容器上只会向上冒泡）
      const target = document.elementFromPoint(x, y) ?? preview;
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    } catch { /* ignore */ }
    await sleep(stepMs);
  }
  // 后 60%：滚动刺激（内滚容器优先，全程下行再上行）
  if (scroller && maxTop > 0) {
    for (let i = 0; i <= steps / 2; i++) {
      scroller.scrollTop = (maxTop * i) / (steps / 2);
      await sleep(stepMs);
    }
    for (let i = steps / 2; i >= 0; i--) {
      scroller.scrollTop = (maxTop * i) / (steps / 2);
      await sleep(stepMs);
    }
    scroller.scrollTop = savedTop;
  } else {
    for (let i = 0; i < steps / 2; i++) {
      window.scrollBy(0, 20);
      await sleep(stepMs);
    }
    for (let i = 0; i < steps / 2; i++) {
      window.scrollBy(0, -20);
      await sleep(stepMs);
    }
    window.scrollTo(0, y0);
  }
}

/**
 * 移动探针：core 的 sampleElement deep 模式只覆盖 el 的前 6 个后代（文档序），
 * 深层运动元素（如 PerspectiveGrid 的 grid skin 是第 7 个后代）会被截断漏采。
 * 先用 ~600ms 双读 transform/opacity/filter 找到真正在动的后代，把它作为采样目标。
 */
async function probeMoving(preview: Element, probeMs = 600): Promise<Element | null> {
  const els = Array.from(preview.querySelectorAll('*')).slice(0, 80);
  const read = () =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return `${cs.transform}|${cs.opacity}|${cs.filter}`;
    });
  const a = read();
  await sleep(probeMs);
  const b = read();
  for (let i = 0; i < els.length; i++) {
    if (a[i] !== b[i]) return els[i];
  }
  return null;
}

/**
 * 采样兜底：sampleElement 3000ms（deep 覆盖前 6 个后代）+ fitSegments。
 * interact=true 时并发执行 pointer/scroll 刺激（用于结构化与 hover 均为空的卡片）。
 * 采样前先做移动探针：发现深层运动元素则以它为采样目标（弥补 deep 只采前 6 后代的截断）。
 */
export async function sample(index: number, sampleMs = 3000, interact = false): Promise<SampleResult> {
  const card = cardAt(index);
  if (!card) return { ok: false, reason: 'card-not-found' };
  const preview = previewOf(card);
  if (!preview) return { ok: false, reason: 'preview-not-found', title: titleOf(card) };
  try {
    const moving = await probeMoving(preview);
    const stim = interact ? stimulate(preview, sampleMs) : Promise.resolve();
    let curve = await sampleElement(moving ?? preview, sampleMs, { deep: true });
    await stim;
    // 探针目标采不出有效段时回退 preview 级采样（探针可能选中微动元素而错过真正的动画）
    if (moving && fitSegments(curve).length === 0) {
      curve = await sampleElement(preview, sampleMs, { deep: true });
    }
    const segments = fitSegments(curve);
    return {
      ok: true,
      channels: Object.keys(curve.channels),
      segments,
      fps: curve.fps,
      durationMs: curve.durationMs,
    };
  } catch (e) {
    return { ok: false, reason: `sample-threw: ${(e as Error)?.message ?? e}` };
  }
}

export function cardCount(): number {
  return cards().length;
}

/**
 * 点击目标：preview 内第一个可交互子元素（button/[role=button]/a/input/label），
 * 找不到则返回 preview 几何中心。用于 playwright 真实点击（GridExpand 需点缩略图等）。
 */
export function clickTargetBox(index: number): { x: number; y: number } | null {
  const card = cardAt(index);
  if (!card) return null;
  const preview = previewOf(card);
  if (!preview) return null;
  // 排除预览自带的「重新播放」按钮（点击会 remount 预览，采样中途目标被卸载）
  const interactive = preview.querySelector(
    'button:not([aria-label="重新播放"]), [role="button"], a, input, label, select',
  );
  const pr = preview.getBoundingClientRect();
  if (interactive) {
    const r = interactive.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    // 可交互元素可能被内部滚动容器裁到视区外（坐标在 preview 外），此时退化为中心点
    if (r.width > 0 && r.height > 0 && x >= pr.x && x <= pr.x + pr.width && y >= pr.y && y <= pr.y + pr.height) {
      return { x, y };
    }
  }
  if (pr.width <= 0 || pr.height <= 0) return null;
  return { x: pr.x + pr.width / 2, y: pr.y + pr.height / 2 };
}

export function cardTitles(): string[] {
  return cards().map(titleOf);
}

const api = { scan, replayScan, hoverScan, clickScan, sample, cardCount, cardTitles, clickTargetBox };
(window as unknown as { __mlBench: typeof api }).__mlBench = api;
export default api;
