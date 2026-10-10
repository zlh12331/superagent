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

    vi.advanceTimersByTime(100);
    expect(globMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(globMock).toHaveBeenCalledTimes(1);
    expect(globMock).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '**/*[aA]*', path: 'C:\\proj', maxResults: 10 }),
    );
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
