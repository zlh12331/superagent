// src/renderer/hooks/__tests__/use-sidebar-highlight.test.tsx
// 侧边栏搜索高亮测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 该副作用此前内联在 Sidebar（3 个 effect/ref，是复杂度 16 + 函数体 219 行
// 双超限的主因），提取后首次获得独立覆盖。
//
// 测试要点：
// 1. computeHighlightedIds（纯函数）：三态语义 —— null（关键词过短，不动作）
//    / 命中集合 / 空集合（够长但无匹配，需清除高亮）
// 2. hook：300ms 防抖后才计算；2s 后自动清除；卸载清理在途定时器
// 3. 边界：sessions 变化不重置防抖（经 ref 读取最新值，但不打断计时）
// ──────────────────────────────────────────────────────────────

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SEARCH_HIGHLIGHT_DEBOUNCE_MS,
  SEARCH_HIGHLIGHT_EXPIRE_MS,
  SEARCH_HIGHLIGHT_MIN_CHARS,
} from '@/lib/constants';

import { computeHighlightedIds, useSidebarHighlight } from '../use-sidebar-highlight';

const sessions = [
  { id: 'a', title: 'Fix login bug', workingDir: 'C:\\proj\\frontend' },
  { id: 'b', title: '添加支付功能', workingDir: 'C:\\proj\\backend' },
  { id: 'c', title: 'Docs update', workingDir: 'D:\\work\\FrontEnd' },
];

describe('computeHighlightedIds（纯函数）', () => {
  /** 取匹配 id 列表；null（关键词过短）视为「不应发生」并显式失败 */
  function ids(keyword: string): string[] {
    const result = computeHighlightedIds(sessions, keyword);
    expect(result, `关键词「${keyword}」不应返回 null`).not.toBeNull();
    return [...(result ?? new Set<string>())];
  }

  it('正向：标题命中（大小写不敏感）', () => {
    expect(ids('FIX')).toEqual(['a']);
    expect(ids('login')).toEqual(['a']);
  });

  it('正向：workingDir 命中', () => {
    expect(ids('backend')).toEqual(['b']);
  });

  it('正向：中英混合关键词', () => {
    expect(ids('支付')).toEqual(['b']);
  });

  it('正向：大小写不敏感地跨多字段命中多个（FrontEnd 命中 c，frontend 命中 a）', () => {
    expect(ids('frontend').sort()).toEqual(['a', 'c']);
  });

  it('边界：关键词过短 → null（表示「不动作」，让既有高亮自然过期）', () => {
    // 空串、纯空格、以及长度恰为 MIN-1 的输入都属「过短」
    expect(computeHighlightedIds(sessions, '')).toBeNull();
    expect(computeHighlightedIds(sessions, '   ')).toBeNull();
    const tooShort = 'a'.repeat(Math.max(0, SEARCH_HIGHLIGHT_MIN_CHARS - 1));
    expect(computeHighlightedIds(sessions, tooShort)).toBeNull();
  });

  it('边界：长度达标但无匹配 → 空集合（非 null，语义是「清除」）', () => {
    const result = computeHighlightedIds(sessions, 'zzzz-no-match');
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });

  it('边界：空会话列表 → 空集合（长度达标时）', () => {
    expect(computeHighlightedIds([], 'zzzz')?.size).toBe(0);
  });

  it('异常：关键词含正则元字符按字面量处理（不抛错、不误匹配）', () => {
    // 实现用 String.includes 而非正则，故 '.*' 是字面量比较、不会匹配所有
    expect(computeHighlightedIds(sessions, '.*')?.size).toBe(0);
    // 单字符 '[' 长度不足 → null（走「过短不动作」分支而非匹配）
    expect(computeHighlightedIds(sessions, '[')).toBeNull();
  });
});

describe('useSidebarHighlight（hook）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 推进到「防抖已触发」但「过期定时器未到」的时点 */
  function flushDebounce(): void {
    act(() => {
      vi.advanceTimersByTime(SEARCH_HIGHLIGHT_DEBOUNCE_MS);
    });
  }

  it('正向：防抖窗口内不计算，到点后高亮命中项', () => {
    const { result } = renderHook(() => useSidebarHighlight('login', sessions));

    // 防抖窗口内尚未计算
    expect(result.current.highlightedIds.size).toBe(0);

    flushDebounce();
    expect([...result.current.highlightedIds]).toEqual(['a']);
  });

  it('正向：高亮 2 秒后自动清除', () => {
    const { result } = renderHook(() => useSidebarHighlight('login', sessions));
    flushDebounce();
    expect(result.current.highlightedIds.size).toBe(1);

    act(() => {
      vi.advanceTimersByTime(SEARCH_HIGHLIGHT_EXPIRE_MS);
    });
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('边界：关键词过短不打断既有高亮（让其自然过期）', () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useSidebarHighlight(q, sessions),
      { initialProps: { q: 'login' } },
    );
    flushDebounce();
    expect(result.current.highlightedIds.size).toBe(1);

    // 输入退到过短：既有高亮应保留（不被清空），直到 2s 自然过期
    rerender({ q: 'l' });
    flushDebounce();
    expect(result.current.highlightedIds.size).toBe(1);

    act(() => {
      vi.advanceTimersByTime(SEARCH_HIGHLIGHT_EXPIRE_MS);
    });
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('边界：够长但无匹配 → 清除既有高亮', () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useSidebarHighlight(q, sessions),
      { initialProps: { q: 'login' } },
    );
    flushDebounce();
    expect(result.current.highlightedIds.size).toBe(1);

    rerender({ q: 'zzzz-nomatch' });
    flushDebounce();
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('边界：sessions 变化不重置防抖计时（经 ref 读取最新值）', () => {
    const { result, rerender } = renderHook(
      ({ list }: { list: typeof sessions }) => useSidebarHighlight('login', list),
      { initialProps: { list: sessions } },
    );

    // 防抖窗口内替换 sessions 引用：不应重启动计时器
    rerender({ list: [...sessions] });
    flushDebounce();

    // 到点后仍能正确计算（读到的是最新引用）
    expect([...result.current.highlightedIds]).toEqual(['a']);
  });

  it('异常：卸载清理在途定时器（不产生卸载后 setState）', () => {
    const { unmount } = renderHook(() => useSidebarHighlight('login', sessions));
    flushDebounce();

    unmount();
    // 卸载后推进到过期时点：不应有 act 警告或异常
    act(() => {
      vi.advanceTimersByTime(SEARCH_HIGHLIGHT_EXPIRE_MS * 2);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
