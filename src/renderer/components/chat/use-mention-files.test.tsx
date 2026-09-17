// src/renderer/components/chat/__tests__/use-mention-files.test.tsx
// useMentionFiles：@ 触发的文件搜索 hook（200ms 防抖 + 生命周期清理）
//
// 测试要点：
// 1. 非 mention 触发态 → 不调 glob、候选清空
// 2. mention 触发 → 防抖 200ms 后调 glob 并返回候选
// 3. 防抖：200ms 内查询词变化只发最后一次
// 4. error 响应 / 网络异常 → 候选清空
// 5. workingDir 缺失（浏览器模式）→ 不调 glob

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMentionFiles } from './use-mention-files';

describe('useMentionFiles', () => {
  const globMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    globMock.mockReset();
    window.api.search = { glob: globMock } as never;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('非 mention 触发态：不调 glob，候选为空', () => {
    const { result } = renderHook(() => useMentionFiles('slash', 'cl', 'C:\\proj'));
    vi.advanceTimersByTime(500);
    expect(globMock).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('mention 触发：防抖 200ms 后调 glob 并返回候选', async () => {
    globMock.mockResolvedValue({ data: { files: ['src/a.ts', 'src/b.ts'] } });
    const { result } = renderHook(() => useMentionFiles('mention', 'a', 'C:\\proj'));

    // 防抖窗口内：尚未调用
    vi.advanceTimersByTime(100);
    expect(globMock).not.toHaveBeenCalled();

    // advanceTimersByTimeAsync：触发定时器的同时冲刷 promise 微任务链；
    // 包 act：setMentionFiles 的状态更新需在 act 内提交（否则渲染不刷新）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(globMock).toHaveBeenCalledTimes(1);
    // 模式经 lib/file-search.buildFileSearchPattern 构造（单一真源）：
    // 递归通配 + 大小写展开（[aA]）+ 尾通配——与 fuzzy-search-dialog 一致
    expect(globMock).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '**/*[aA]*', path: 'C:\\proj', maxResults: 10 }),
    );
    // act 已提交状态更新，直接断言（waitFor 依赖真实定时器，与 fake timers 冲突会挂死）
    expect(result.current).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('防抖：200ms 内查询词变化只发最后一次', () => {
    globMock.mockResolvedValue({ data: { files: [] } });
    const { rerender } = renderHook(({ q }) => useMentionFiles('mention', q, 'C:\\proj'), {
      initialProps: { q: 'a' as string | null },
    });

    rerender({ q: 'ab' });
    rerender({ q: 'abc' });
    vi.advanceTimersByTime(500);

    expect(globMock).toHaveBeenCalledTimes(1);
    expect(globMock).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '**/*[aA][bB][cC]*' }),
    );
  });

  it('回归：查询词含 glob 元字符时被转义为字面量（不改变匹配语义）', () => {
    globMock.mockResolvedValue({ data: { files: [] } });
    renderHook(() => useMentionFiles('mention', 'a*b', 'C:\\proj'));
    vi.advanceTimersByTime(500);

    // 未转义时 `a*b` 会退化为「a 任意 b 前缀」；转义后按字面量搜索
    expect(globMock).toHaveBeenCalledWith(expect.objectContaining({ pattern: '**/*[aA]\\*[bB]*' }));
  });

  it('error 响应：候选清空（unwrap 抛错被吞）', async () => {
    globMock.mockResolvedValue({ error: { code: 'SEARCH_FAILED', message: 'boom' } });
    const { result } = renderHook(() => useMentionFiles('mention', '', 'C:\\proj'));

    await vi.advanceTimersByTimeAsync(300);
    expect(globMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([]);
  });

  it('workingDir 缺失（浏览器模式）：不调 glob', () => {
    renderHook(() => useMentionFiles('mention', 'a', undefined));
    vi.advanceTimersByTime(500);
    expect(globMock).not.toHaveBeenCalled();
  });
});
