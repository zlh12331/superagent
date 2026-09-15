// src/renderer/components/chat/message-offsets.test.ts
// 导航轨偏移测量与二分查找纯逻辑测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. measureMessages：属性缺失/非数字跳过、按 top 升序、读取 offsetTop
// 2. isSnapshotFresh：null / 高度一致 / 高度变化
// 3. findActiveMessageIndex：中点落在首条之上 → -1、命中最后一条 <= 中点、空数组
// 4. findUserOrder：活跃索引之前的最后一个用户序、无匹配 → null、空/负索引
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  findActiveMessageIndex,
  findUserOrder,
  isSnapshotFresh,
  type LayoutSnapshot,
  type MeasuredMessage,
  measureMessages,
} from './message-offsets';

const ATTR = 'data-msg-index';

/** 构造带 data-msg-index 的容器（offsetTop 由 jsdom 恒为 0，故用 defineProperty 注入） */
function makeContainer(entries: readonly { index: string | null; top: number }[]): HTMLElement {
  const container = document.createElement('div');
  for (const entry of entries) {
    const node = document.createElement('div');
    if (entry.index !== null) node.setAttribute(ATTR, entry.index);
    Object.defineProperty(node, 'offsetTop', { value: entry.top, configurable: true });
    container.appendChild(node);
  }
  return container;
}

describe('measureMessages', () => {
  it('读取 offsetTop 与全量索引，并按 top 升序返回', () => {
    const el = makeContainer([
      { index: '2', top: 300 },
      { index: '0', top: 0 },
      { index: '1', top: 150 },
    ]);
    expect(measureMessages(el, ATTR)).toEqual([
      { messageIndex: 0, top: 0 },
      { messageIndex: 1, top: 150 },
      { messageIndex: 2, top: 300 },
    ]);
  });

  it('无属性节点与非数字属性一律跳过', () => {
    const el = makeContainer([
      { index: null, top: 10 },
      { index: 'abc', top: 20 },
      { index: '5', top: 30 },
    ]);
    expect(measureMessages(el, ATTR)).toEqual([{ messageIndex: 5, top: 30 }]);
  });

  it('无匹配节点 → 空数组', () => {
    expect(measureMessages(makeContainer([]), ATTR)).toEqual([]);
  });
});

describe('isSnapshotFresh', () => {
  const snapshot: LayoutSnapshot = { measured: [], scrollHeight: 1000 };

  it('null 快照 → 不新鲜', () => {
    expect(isSnapshotFresh(null, 1000)).toBe(false);
  });

  it('高度一致 → 新鲜；高度变化 → 失效', () => {
    expect(isSnapshotFresh(snapshot, 1000)).toBe(true);
    expect(isSnapshotFresh(snapshot, 1001)).toBe(false);
  });
});

describe('findActiveMessageIndex', () => {
  const measured: readonly MeasuredMessage[] = [
    { messageIndex: 10, top: 0 },
    { messageIndex: 11, top: 100 },
    { messageIndex: 12, top: 200 },
  ];

  it('中点尚在首条之上 → -1', () => {
    expect(findActiveMessageIndex(measured, -1)).toBe(-1);
    expect(findActiveMessageIndex(measured, -0.5)).toBe(-1);
  });

  it('命中 top <= 中点的最后一条', () => {
    expect(findActiveMessageIndex(measured, 0)).toBe(10);
    expect(findActiveMessageIndex(measured, 99)).toBe(10);
    expect(findActiveMessageIndex(measured, 100)).toBe(11);
    expect(findActiveMessageIndex(measured, 250)).toBe(12);
  });

  it('空数组 → -1', () => {
    expect(findActiveMessageIndex([], 100)).toBe(-1);
  });
});

describe('findUserOrder', () => {
  const userIndices: readonly number[] = [1, 4, 7, 9];

  it('返回活跃索引之前的最后一个用户序（0-based）', () => {
    expect(findUserOrder(userIndices, 1)).toBe(0);
    expect(findUserOrder(userIndices, 5)).toBe(1);
    expect(findUserOrder(userIndices, 9)).toBe(3);
    expect(findUserOrder(userIndices, 100)).toBe(3);
  });

  it('活跃索引早于全部用户消息 → null', () => {
    expect(findUserOrder(userIndices, 0)).toBeNull();
  });

  it('无活跃索引（-1）/空列表 → null', () => {
    expect(findUserOrder(userIndices, -1)).toBeNull();
    expect(findUserOrder([], 5)).toBeNull();
  });
});
