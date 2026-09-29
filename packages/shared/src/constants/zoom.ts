// packages/shared/src/constants/zoom.ts
// 界面缩放常量与纯函数（35 号界面缩放；单一真源，主进程/渲染层共用）
// ──────────────────────────────────────────────────────────────
// 档位集：Chrome/Chromium 缩放预设谱系（0.5/0.67/0.75/0.8/0.9/1/1.1/1.25/
// 1.5/1.75/2）——浏览器成熟惯例，细档位给低视力用户台阶。
// zoomFactor 语义：DIP 缩放系数，1 = 100%（Electron webContents.setZoomFactor）。
// ──────────────────────────────────────────────────────────────

/** 合法缩放档位（升序；clampZoom/stepZoom/UI Select 共用） */
export const ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

/** 默认缩放（100%；settings.appearance.zoom 缺失/损坏时 clampZoom 的锚点之一） */
export const DEFAULT_ZOOM = 1;

/**
 * 任意数值归一到最近合法档位（损坏 DB 值归一——0.93 → 0.9，非整域丢弃）
 */
export function clampZoom(value: number): number {
  let nearest = ZOOM_LEVELS[0] as number;
  let best = Number.POSITIVE_INFINITY;
  for (const level of ZOOM_LEVELS) {
    const dist = Math.abs(level - value);
    if (dist < best) {
      best = dist;
      nearest = level;
    }
  }
  return nearest;
}

/**
 * 快捷键调档（当前档位索引 ±1；两端钳制不回绕）
 *
 * current 不在档位集内时先归一（与 clampZoom 同语义）。
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const normalized = clampZoom(current);
  const index = ZOOM_LEVELS.indexOf(normalized);
  const next = Math.min(Math.max(index + direction, 0), ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[next] as number;
}

/**
 * Windows titleBarOverlay 高度（DIP）随缩放联动
 *
 * 52 DIP 是 --topbar-h 的控件区基准（window.ts 创建参数）；CSS 顶栏随 zoomFactor
 * 缩放而 overlay.height 固定，不联动则非 100% 档位控件区与顶栏错位。
 */
export function overlayHeightFor(zoom: number): number {
  return Math.round(52 * zoom);
}
