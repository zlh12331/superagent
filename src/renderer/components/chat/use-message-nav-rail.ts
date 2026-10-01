// src/renderer/components/chat/use-message-nav-rail.ts
// 消息导航轨状态：用户消息锚点 + 滚动联动的活跃圆点（自 ChatMessageList 提取）
// ──────────────────────────────────────────────
// 性能：滚动事件不逐条读 offsetTop（旧实现每次滚动强制整列表重排，200 条窗口
// 下明显掉帧）。改为「一次测量得到有序偏移快照 + 每帧二分查找」，按职责三层拆分：
// - useQuestionAnchors：每个用户消息派生一个跳转锚点（含预览截断）
// - useMeasureOffsets：偏移快照与失效——消息集或渲染窗口变化即作废重测
// - useActiveTurn：视口中线 → 活跃锚点序；rAF 合帧，卸载撤销，挂载先同步一次
//   （内容不满一屏时不会有滚动事件，挂载不主动算则首帧无高亮且无法补算）
// ──────────────────────────────────────────────

import type { UIMessage } from 'ai';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { extractText } from '@/lib/chat/message-text';

import {
  findActiveMessageIndex,
  findUserOrder,
  isSnapshotFresh,
  type LayoutSnapshot,
  type MeasuredMessage,
  measureMessages,
} from './message-offsets';

/** 消息导航轨元素的数据属性（滚动定位 / 偏移测量用） */
export const MSG_INDEX_ATTR = 'data-msg-index';

/** 用户消息预览截断长度（跳转条预览） */
const PREVIEW_MAX_CHARS = 60;

/** 跳转条锚点（对齐参考项目 QuestionAnchor：每个用户消息一个锚点） */
export interface QuestionAnchor {
  /** React key（消息索引派生） */
  readonly id: string;
  /** 用户消息序号（0-based） */
  readonly turn: number;
  /** 消息列表索引（点击滚动用） */
  readonly messageIndex: number;
  /** 用户消息内容预览（截断） */
  readonly text: string;
}

interface NavRailOptions {
  /** 全量消息（锚点与预览文本数据源） */
  readonly messages: readonly UIMessage[];
  /** 滚动容器 ref（读取视口位置与消息节点） */
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
}

interface NavRailState {
  /** 全量用户消息锚点（跳转条数据源） */
  readonly questions: readonly QuestionAnchor[];
  /** 当前活跃锚点 turn（滚动联动；null = 无活跃） */
  readonly activeTurn: number | null;
  /** 合帧请求一次活跃圆点更新（滚动事件用） */
  readonly scheduleSync: () => void;
}

/**
 * 消息导航轨：锚点计算 + 滚动联动的活跃圆点
 *
 * 入参见 {@link NavRailOptions}（消息集、滚动容器 ref）。
 *
 * @returns 锚点列表、活跃 turn、合帧同步触发器
 */
export function useMessageNavRail({ messages, scrollerRef }: NavRailOptions): NavRailState {
  // 圆点代表用户消息而非每条消息（对齐参考项目 VerticalProgressBar）
  // 纯派生数组：引用稳定性交给 React Compiler（下游 effect 以身份作「集合已变」信号）
  const userMessageIndices = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  const questions = useQuestionAnchors(messages, userMessageIndices);
  const readMeasured = useMeasureOffsets({ userMessageIndices });
  const { activeTurn, scheduleSync } = useActiveTurn({
    scrollerRef,
    readMeasured,
    userMessageIndices,
    messageCount: messages.length,
  });
  return { questions, activeTurn, scheduleSync };
}

/** 跳转条锚点：每个用户消息一个（跳转条内部滚动承载预览，无需比例映射） */
function useQuestionAnchors(
  messages: readonly UIMessage[],
  userMessageIndices: readonly number[],
): readonly QuestionAnchor[] {
  // 纯派生，交给 React Compiler 记忆化
  return userMessageIndices.map((messageIndex, i) => {
    const text = extractText(messages[messageIndex]?.parts ?? []);
    return {
      id: `q-${messageIndex}`,
      turn: i,
      messageIndex,
      text: text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text,
    };
  });
}

interface MeasureOffsetsOptions {
  /** 用户消息索引（引用随消息集变化，作为「需重测」信号；稳定性由 React Compiler 保证） */
  readonly userMessageIndices: readonly number[];
}

/** 偏移表读取器：快照仍适用于当前内容高度时复用，否则重测一次 */
function useMeasureOffsets({
  userMessageIndices,
}: MeasureOffsetsOptions): (el: HTMLElement) => readonly MeasuredMessage[] {
  const snapshotRef = useRef<LayoutSnapshot | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖只是「可见消息集合变了即作废快照」的触发信号，effect 体本就不读取它
  useEffect(() => {
    snapshotRef.current = null;
  }, [userMessageIndices]);
  // 仅捕获 snapshotRef，引用稳定性交给 React Compiler
  return (el: HTMLElement): readonly MeasuredMessage[] => {
    const cached = snapshotRef.current;
    if (cached !== null && isSnapshotFresh(cached, el.scrollHeight)) return cached.measured;
    const measured = measureMessages(el, MSG_INDEX_ATTR);
    snapshotRef.current = { measured, scrollHeight: el.scrollHeight };
    return measured;
  };
}

interface ActiveTurnOptions {
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly readMeasured: (el: HTMLElement) => readonly MeasuredMessage[];
  readonly userMessageIndices: readonly number[];
  readonly messageCount: number;
}

/** 活跃锚点序：随滚动位置更新，rAF 合帧（一帧内多次滚动事件只测一次） */
function useActiveTurn({
  scrollerRef,
  readMeasured,
  userMessageIndices,
  messageCount,
}: ActiveTurnOptions): { readonly activeTurn: number | null; readonly scheduleSync: () => void } {
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const indicesRef = useRef(userMessageIndices);
  useEffect(() => {
    indicesRef.current = userMessageIndices;
  }, [userMessageIndices]);
  // 引用稳定性交给 React Compiler（捕获 readMeasured / scrollerRef / ref / setter）
  const sync = (el: HTMLElement): void => {
    const midpoint = el.scrollTop + el.clientHeight / 2;
    const activeMessageIndex = findActiveMessageIndex(readMeasured(el), midpoint);
    const order = findUserOrder(indicesRef.current, activeMessageIndex);
    setActiveTurn((prev) => (prev === order ? prev : order));
  };
  // sync / scheduleSync 身份不进 effect 依赖：实现经 ref 调最新闭包
  // （统一 useLatestRef：写入在 effect 阶段，避免渲染期写 ref）
  const syncRef = useLatestRef(sync);
  const frameRef = useRef<number | null>(null);
  const scheduleSync = (): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // 回调延后一帧，容器可能已卸载 → 重新取而非复用旧引用
      const el = scrollerRef.current;
      if (el !== null) syncRef.current(el);
    });
  };
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  // 依赖只留「重新同步」的触发信号；实现经 ref 调最新闭包，effect 体不读 scrollerRef.current
  // （否则 exhaustive-deps 会要求把 .current 列入依赖——ref 身份本就稳定，属误报）
  const runSync = useRef(() => {
    const el = scrollerRef.current;
    if (el !== null) syncRef.current(el);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: userMessageIndices/messageCount 仅作「重新同步」触发信号（圆点经 indicesRef 读取），effect 体不直接引用
  useEffect(() => {
    runSync.current();
  }, [userMessageIndices, messageCount]);
  return { activeTurn, scheduleSync };
}
