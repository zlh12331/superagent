// editor.ts：编辑器代码面排版常量的单一真源（Tab 宽度档位 / 默认值 / 损坏值读侧归一）
// 值语义 = CSS `tab-size`：渲染层经 --code-tab-size 变量收敛文件查看器 / 聊天代码块 / diff 行。

/** 合法 Tab 宽度档位（升序；写侧 schema 门禁、SegControl 选项与 clampEditorTabSize 共用） */
export const EDITOR_TAB_SIZES: readonly number[] = [2, 4, 8];

/** 默认 Tab 宽度（8 = 浏览器 tab-size 默认口径，取现状保证升级零视觉变化；缺字段与非有限数都回落此值） */
export const DEFAULT_EDITOR_TAB_SIZE = 8;

/**
 * 任意数值归一到最近合法档位（读侧兜底：settings:getAll 快照的库中 JSON 不经写侧 schema）
 *
 * 等距取较小档（6 → 4：6 距 4/8 各 2），该语义依赖档位表升序，非整域丢弃。
 * 非有限数（undefined/NaN/Infinity，即「缺失或彻底损坏」）→ DEFAULT_EDITOR_TAB_SIZE：
 * NaN 比较全 false 会把结果停在数组首项，必须前置拦截（clampZoom 同款教训，见 constants/zoom.ts）。
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
