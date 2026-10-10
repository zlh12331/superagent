/**
 * clamp() 三元组解析结果。
 * min/max 为像素数值，preferred 为 vw 比例（如 0.17 = 17vw）。
 */
interface ClampValues {
  min: number;
  max: number;
  preferredVw: number;
}

/**
 * 从 CSS 自定义属性读取 clamp(min, preferred, max) 字符串并解析。
 *
 * 支持格式：`clamp(160px, 17vw, 480px)` 或 `clamp(160px,17vw,480px)`
 * 仅支持 px + vw 单位（项目令牌规范），遇到不支持的格式回退到安全默认值。
 *
 * @param varName CSS 自定义属性名（如 '--sidebar-w'）
 * @param fallback 解析失败时的安全回退值
 */
function parseClamp(varName: string, fallback: ClampValues): ClampValues {
  if (typeof window === 'undefined') return fallback;

  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

  if (!raw) return fallback;

  const match = raw.match(/clamp\(\s*([\d.]+px)\s*,\s*([\d.]+vw)\s*,\s*([\d.]+px)\s*\)/i);
  if (!match) return fallback;

  const [, minStr, prefStr, maxStr] = match;
  if (minStr === undefined || prefStr === undefined || maxStr === undefined) {
    return fallback;
  }
  const min = parseFloat(minStr);
  const preferredVw = parseFloat(prefStr) / 100;
  const max = parseFloat(maxStr);

  if (Number.isNaN(min) || Number.isNaN(preferredVw) || Number.isNaN(max)) {
    return fallback;
  }

  return { min, max, preferredVw };
}

/** 计算 clamp() 的实际像素值（等价 CSS clamp() 语义） */
function resolveClamp(cv: ClampValues, viewportWidth: number): number {
  const preferred = viewportWidth * cv.preferredVw;
  return Math.max(cv.min, Math.min(cv.max, preferred));
}

const SIDEBAR_FALLBACK: ClampValues = { min: 200, max: 280, preferredVw: 0.17 };
const RIGHT_PANEL_FALLBACK: ClampValues = { min: 260, max: 360, preferredVw: 0.22 };

/** 侧边栏宽度约束（从 CSS --sidebar-w 解析） */
function getSidebarClamp(): ClampValues {
  return parseClamp('--sidebar-w', SIDEBAR_FALLBACK);
}

/** 右面板宽度约束（从 CSS --right-panel-w 解析） */
function getRightPanelClamp(): ClampValues {
  return parseClamp('--right-panel-w', RIGHT_PANEL_FALLBACK);
}

/** 侧边栏宽度下限（px） */
export const SIDEBAR_WIDTH_MIN = getSidebarClamp().min;
/** 侧边栏宽度上限（px） */
export const SIDEBAR_WIDTH_MAX = getSidebarClamp().max;
/** 右面板宽度下限（px） */
export const RIGHT_PANEL_WIDTH_MIN = getRightPanelClamp().min;
/** 右面板宽度上限（px） */
export const RIGHT_PANEL_WIDTH_MAX = getRightPanelClamp().max;

/**
 * 根据视口宽度计算初始侧边栏宽度（等价 CSS clamp() 解析值）。
 */
export function computeInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return resolveClamp(SIDEBAR_FALLBACK, 1440);
  return Math.round(resolveClamp(getSidebarClamp(), window.innerWidth));
}

/**
 * 根据视口宽度计算初始右面板宽度（等价 CSS clamp() 解析值）。
 */
export function computeInitialRightPanelWidth(): number {
  if (typeof window === 'undefined') return resolveClamp(RIGHT_PANEL_FALLBACK, 1440);
  return Math.round(resolveClamp(getRightPanelClamp(), window.innerWidth));
}
