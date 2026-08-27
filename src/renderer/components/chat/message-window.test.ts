// src/renderer/components/chat/message-window.test.ts
// 消息分页渲染窗口纯函数单测（长会话性能根治）
//
// 测试要点：
// 1. 初始窗口：只渲染最近 PAGE_SIZE 条；消息少时从 0 开始
// 2. 向上翻页：每次前进一页，不低于 0
// 3. 跳转扩展：窗口外目标对齐到所在页起点
// 4. 安全裁剪：切换会话后窗口越界时 clamp 到消息总数

import { describe, expect, it } from 'vitest';

import {
  clampStart,
  ensureIndexStart,
  initialWindowStart,
  MESSAGE_PAGE_SIZE,
  nextPageStart,
} from './message-window';

describe('initialWindowStart', () => {
  it('长会话（5000 条）：窗口起点 = total - PAGE_SIZE', () => {
    expect(initialWindowStart(5000)).toBe(5000 - MESSAGE_PAGE_SIZE);
  });

  it('消息数少于 PAGE_SIZE：从 0 开始（全量渲染）', () => {
    expect(initialWindowStart(50)).toBe(0);
  });

  it('空会话：0', () => {
    expect(initialWindowStart(0)).toBe(0);
  });
});

describe('nextPageStart', () => {
  it('向上翻一页', () => {
    expect(nextPageStart(4800)).toBe(4800 - MESSAGE_PAGE_SIZE);
  });

  it('低于 0 时钳制到 0（已到最早）', () => {
    expect(nextPageStart(50)).toBe(0);
  });
});

describe('ensureIndexStart', () => {
  it('目标在窗口外（更早）：对齐到目标所在页起点', () => {
    expect(ensureIndexStart(100, 4800)).toBe(0);
    expect(ensureIndexStart(2500, 4800)).toBe(2400);
  });

  it('目标已在窗口内：起点不变', () => {
    expect(ensureIndexStart(4900, 4800)).toBe(4800);
  });
});

describe('clampStart', () => {
  it('起点未越界：原样返回', () => {
    expect(clampStart(2000, 5000)).toBe(2000);
  });

  it('起点越界（切换会话后）：钳制到消息总数', () => {
    expect(clampStart(4800, 3000)).toBe(3000);
  });

  it('空会话：0', () => {
    expect(clampStart(200, 0)).toBe(0);
  });
});
