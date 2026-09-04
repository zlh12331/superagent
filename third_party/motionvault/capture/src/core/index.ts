/**
 * index.ts —— MotionLens 提取引擎编排入口。
 * 流程：pickElement → observeTriggers → extractAnimations
 *      →（结构化结果为空且未禁用兜底时）sample/fit 采样兜底（桩未实现时静默降级）
 *      → 组装 CaptureReport。
 */
import type { CaptureOptions, CaptureReport } from './types';
import { pickElement } from './picker';
import { observeTriggers } from './trigger';
import { extractAnimations } from './extract';
import { computedBase, domSnippet } from './dom';

export const TOOL_VERSION = '0.1.0';

export async function capture(opts: CaptureOptions = {}): Promise<CaptureReport | null> {
  const el = await pickElement(opts);
  if (!el) return null; // 用户取消
  opts.onPicked?.(el);

  const { animations, trigger } = await observeTriggers(el, opts.observeMs);
  const captured = extractAnimations(animations, el, trigger);

  // 采样兜底：sample/fit 由 cap-sampler 实现；桩抛错时静默降级
  let sampled: CaptureReport['sampled'];
  if (captured.length === 0 && opts.sampleFallback !== false) {
    try {
      const { sampleElement } = await import('./sample');
      const { fitSegments } = await import('./fit');
      const curve = await sampleElement(el, opts.sampleMs);
      sampled = { curve, segments: fitSegments(curve) };
    } catch {
      // 兜底模块未就绪或采样失败 —— 结构化结果为空也照常出报告
    }
  }

  const rect = el.getBoundingClientRect();
  return {
    tool: { name: 'motionlens', version: TOOL_VERSION },
    url: location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    elementBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    computedBase: computedBase(el),
    animations: captured,
    ...(sampled ? { sampled } : {}),
    domSnippet: domSnippet(el),
  };
}

export * from './types';
export { pickElement } from './picker';
export { observeTriggers } from './trigger';
export type { ObserveResult } from './trigger';
export { extractAnimations } from './extract';
export { computedBase, domSnippet, targetSummary } from './dom';
