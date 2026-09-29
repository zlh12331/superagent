// src/renderer/lib/zoom.ts
// 界面缩放应用（35 号 spec §2.1：渲染层唯一应用出口）
// ──────────────────────────────────────────────────────────────
// 与 shared/constants/zoom.ts 的分工：档位/归一/步进等纯计算在 shared（主进程
// handler 与渲染层共用单一真源）；本文件是「应用」薄壳——把生效值经
// window:applyZoom 交给主进程执行（渲染层 sandbox 无 webContents 句柄，
// 主进程单点收口 setZoomFactor + Windows overlay 联动）。
//
// 无桥（浏览器模式/单测）no-op 不抛（反例 3）。clampZoom 兜底：任何调用方
// 传入非档位值都在此归一到最近档位（快照合并处已归一，此处为第二道防线）。
// ──────────────────────────────────────────────────────────────

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
    // 无桥：浏览器模式行为无感（与 settings-store persistSetting 同语义）
    return;
  }
  try {
    await applyFn({ zoom: normalized });
  } catch {
    // 应用失败非致命（窗口销毁竞态等）：静默——下一次 store 变更会重试
  }
}
