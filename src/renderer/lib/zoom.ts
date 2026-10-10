import { clampZoom } from '@code-agent/shared/renderer';

/**
 * 应用界面缩放（渲染层唯一应用出口）
 *
 * 生效时机：① main.tsx bootstrap 后 render 前（首帧值，无跳变）② AppShell
 * useZoomEffect 订阅 store 变化（运行中改档）。两处幂等（同值重复调用无害）。
 */
export async function applyZoom(zoom: number): Promise<void> {
  const normalized = clampZoom(zoom);
  const api = window.api;
  const applyFn = api?.window?.applyZoom;
  if (typeof applyFn !== 'function') {
    return;
  }
  try {
    await applyFn({ zoom: normalized });
  } catch {}
}
