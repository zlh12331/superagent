// src/renderer/components/chat/message-window.ts
// 消息分页渲染窗口（纯函数层；2026-08 长会话性能根治）
// ──────────────────────────────────────────────────────────────
// 背景：单会话消息可达数千至上万条（Code Agent 长会话），全量挂载
// 数千个 DOM（每条含 Markdown 解析 + 代码块 shiki）首屏卡顿。
//
// 方案 A（分页渲染）：数据全量保留在 useChat messages（LLM 上下文
// 不受影响），仅裁剪 DOM——默认只渲染最近 PAGE_SIZE 条，滚动到顶
// 加载更早批次；首屏挂载成本固定。
//
// 本文件只含纯函数（窗口边界计算），组件侧负责滚动触发与锚定补偿。
// ──────────────────────────────────────────────────────────────

/** 单页渲染消息数（首屏挂载成本 = 固定 PAGE_SIZE 条） */
export const MESSAGE_PAGE_SIZE = 200;

/** 初始窗口起点：仅渲染最近 PAGE_SIZE 条 */
export function initialWindowStart(total: number): number {
  return Math.max(0, total - MESSAGE_PAGE_SIZE);
}

/** 向上翻一页（滚动到顶加载更早） */
export function nextPageStart(start: number): number {
  return Math.max(0, start - MESSAGE_PAGE_SIZE);
}

/** 确保目标索引在窗口内：窗口外（更早）时对齐到其所在页起点 */
export function ensureIndexStart(index: number, start: number): number {
  if (index < start) {
    return Math.max(0, Math.floor(index / MESSAGE_PAGE_SIZE) * MESSAGE_PAGE_SIZE);
  }
  return start;
}

/** 渲染时安全裁剪：起点不超过消息总数（切换会话后窗口可能越界） */
export function clampStart(start: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(start, total);
}
