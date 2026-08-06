// layout-utils.ts（自 AppShell 拆分）
// 布局纯函数（侧边栏/右面板初始宽度计算）
// ──────────────────────────────
// 拆分背景：AppShell 352 行，纯函数与组件混合，按职责提取
// ──────────────────────────────

/** 侧边栏宽度 clamp 下限 */
export const SIDEBAR_WIDTH_MIN = 200;
/** 侧边栏宽度 clamp 上限 */
export const SIDEBAR_WIDTH_MAX = 400;
/** 右面板宽度 clamp 下限 */
export const RIGHT_PANEL_WIDTH_MIN = 260;
/** 右面板宽度 clamp 上限 */
export const RIGHT_PANEL_WIDTH_MAX = 360;

export function computeInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return 240;
  return Math.round(
    Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth * 0.17)),
  );
}

/**
 * 根据视口宽度计算初始右面板宽度（对齐原型 clamp(260px, 22vw, 360px)）。
 */
export function computeInitialRightPanelWidth(): number {
  if (typeof window === 'undefined') return 317;
  return Math.round(
    Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, window.innerWidth * 0.22)),
  );
}
