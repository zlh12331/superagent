// src/renderer/components/chat/message-offsets.ts
// 导航轨活跃态的布局测量与缓存（纯逻辑，可单测）
// ──────────────────────────────────────────────
// 缺陷背景：滚动事件里对每条已渲染消息做 querySelectorAll + offsetTop 读取，
// 长会话（分页窗口最多 200 条）下每次滚动都强制一次整列表布局，O(n)/事件。
// 策略：一次测量得到有序偏移快照，后续滚动只做二分查找；快照仅在内容高度
// 变化（新增/删除消息、重排）或消息集变化后失效。
// ──────────────────────────────────────────────

/** 单条已渲染消息的测量结果 */
export interface MeasuredMessage {
  /** 全量消息索引（非窗口内相对索引） */
  readonly messageIndex: number;
  /** 相对滚动内容顶部的偏移（px） */
  readonly top: number;
}

/** 布局快照：measured 按 top 升序（DOM 顺序即消息顺序） */
export interface LayoutSnapshot {
  readonly measured: readonly MeasuredMessage[];
  /** 测量时的容器 scrollHeight（用于判断内容是否已重排） */
  readonly scrollHeight: number;
}

/**
 * 测量所有已渲染消息的偏移（本模块唯一读取布局的地方）
 *
 * 调用频率由快照失效规则控制：每个「内容高度变化后的第一帧」一次，而非每次滚动。
 */
export function measureMessages(el: HTMLElement, indexAttr: string): readonly MeasuredMessage[] {
  const measured: MeasuredMessage[] = [];
  for (const node of el.querySelectorAll(`[${indexAttr}]`)) {
    const raw = node.getAttribute(indexAttr);
    if (raw === null) continue;
    const messageIndex = Number(raw);
    if (!Number.isFinite(messageIndex)) continue;
    measured.push({ messageIndex, top: (node as HTMLElement).offsetTop });
  }
  // 二分查找前置条件：按 top 升序（DOM 顺序本已如此，显式排序防自定义布局乱序）
  return measured.sort((a, b) => a.top - b.top);
}

/** 快照是否仍适用于当前内容高度 */
export function isSnapshotFresh(snapshot: LayoutSnapshot | null, scrollHeight: number): boolean {
  return snapshot !== null && snapshot.scrollHeight === scrollHeight;
}

/**
 * 二分查找：视口中线所在消息（top <= midpoint 的最后一条）
 *
 * @returns 消息索引；中线尚在首条消息之上时 -1
 */
export function findActiveMessageIndex(
  measured: readonly MeasuredMessage[],
  midpoint: number,
): number {
  let low = 0;
  let high = measured.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = measured[middle];
    if (item !== undefined && item.top <= midpoint) {
      active = item.messageIndex;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}

/**
 * 活跃消息索引 → 用户消息序（导航轨圆点 0-based）
 *
 * @param userMessageIndices 升序的用户消息索引
 * @param activeMessageIndex findActiveMessageIndex 的结果（-1 = 无）
 */
export function findUserOrder(
  userMessageIndices: readonly number[],
  activeMessageIndex: number,
): number | null {
  if (activeMessageIndex < 0 || userMessageIndices.length === 0) return null;
  let low = 0;
  let high = userMessageIndices.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = userMessageIndices[middle];
    if (value !== undefined && value <= activeMessageIndex) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 ? found : null;
}
