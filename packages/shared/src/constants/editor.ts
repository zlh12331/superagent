/** 合法 Tab 宽度档位（升序；SegControl 选项与 clampEditorTabSize 共用） */
export const EDITOR_TAB_SIZES: readonly number[] = [2, 4, 8];

/** 默认 Tab 宽度（8 = 浏览器默认渲染口径——默认取现状保证升级零视觉变化） */
export const DEFAULT_EDITOR_TAB_SIZE = 8;

/**
 * 任意数值归一到最近合法档位（损坏 DB 值归一——6 → 8，非整域丢弃）
 *
 * 非有限数（undefined/NaN/Infinity，即「缺失或彻底损坏」）→ DEFAULT_EDITOR_TAB_SIZE：
 * NaN 比较全 false 会把结果停在数组首项，必须前置拦截（35 号 clampZoom 同款教训）。
 */
export function clampEditorTabSize(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EDITOR_TAB_SIZE;
  }
  let nearest = EDITOR_TAB_SIZES[0] as number;
  let best = Number.POSITIVE_INFINITY;
  for (const size of EDITOR_TAB_SIZES) {
    const dist = Math.abs(size - value);
    if (dist < best) {
      best = dist;
      nearest = size;
    }
  }
  return nearest;
}
