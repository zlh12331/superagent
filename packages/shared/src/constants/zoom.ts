// zoom.ts：应用级界面缩放的档位常量 + 归一/调档/Windows overlay 高度纯函数（主进程与渲染层共用单一真源）
// 数值语义 = webContents.setZoomFactor 的 DIP 缩放系数（1 = 100%）；浏览器预览有独立缩放域，不经此处。
// 设计依据 docs/design/35-ui-zoom-spec.md。
// ────────── 档位常量：全应用缩放的唯一值域与缺省锚点 ──────────
/**
 * 合法缩放档位（升序，11 档）。
 *
 * 谱系取自 Chrome/Chromium 缩放预设，非自造等比序列；设置写入侧门禁
 *（packages/shared/src/schemas/settings.ts 的 superRefine）、设置页 Select 与本文件的
 * 归一/调档同源此表，改表即全链生效。升序是不变式——clampZoom 的就近判定与
 * stepZoom 的索引 ±1 都依赖它。
 */
export const ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

/**
 * 默认缩放（100%）。
 *
 * 三处共用：`Ctrl/Cmd+0` 复位目标、clampZoom 对非有限值的回落锚点，以及设置快照缺
 * `appearance.zoom` 时的初值（src/renderer/stores/persistent/settings-store.ts 的 DEFAULT_SETTINGS）。
 */
export const DEFAULT_ZOOM = 1;

// ────────── 纯函数：只做值域换算，无副作用（zoomFactor 应用与 overlay 重设由调用方负责） ──────────
/**
 * 任意数值归一到最近合法档位（损坏 DB 值归一——0.93 → 0.9，非整域丢弃）。
 *
 * 非有限数（undefined/NaN/Infinity，即「缺失或彻底损坏」）→ DEFAULT_ZOOM：
 * 缺失语义是「默认 100%」而非「钳到最小档」——NaN 比较全 false 会把结果停在
 * 数组首项，必须前置拦截（实施期实测缺陷，docs/design/35-ui-zoom-spec.md §3.2 登记）。
 *
 * 调用方三处：渲染层应用出口（src/renderer/lib/zoom.ts）、设置快照读侧（settings-store
 * 合并时归一）、主进程 window:applyZoom handler（渲染层已归一，此处防 handler 直调方）。
 */
export function clampZoom(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }
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
 * 快捷键调档（当前档位索引 ±1；两端钳制不回绕——已在边界上再按停在原地，不跳到另一端）。
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
 * Windows titleBarOverlay 高度（DIP）随缩放联动。
 *
 * CSS 自绘顶栏随 zoomFactor 缩放，而 overlay.height 是固定 DIP——不联动则非 100%
 * 档位下窗口控件区与顶栏错位。仅 win32 链路需要（调用点在
 * src/main/ipc/window.handler.ts 的 win32 分支，失败只记 warn，缩放本身不受影响）。
 */
export function overlayHeightFor(zoom: number): number {
  // 52 DIP 基准 = 自绘顶栏 --topbar-h（src/renderer/styles/tokens.css），与
  // src/main/window.ts 创建窗口时的 titleBarOverlay.height 同值——改一处须三处同步
  return Math.round(52 * zoom);
}
