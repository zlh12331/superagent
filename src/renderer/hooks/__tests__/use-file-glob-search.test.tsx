// src/renderer/hooks/__tests__/use-file-glob-search.test.tsx
// 文件名搜索 hook 单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖（含此前内联在对话框组件、无独立覆盖的竞态路径）：
// 1. 正向：防抖窗口后调用 search:glob，参数契约（pattern/path/maxResults）
// 2. 竞态：查询变化后旧响应晚到 → 丢弃（不覆盖新结果）
// 3. 竞态：卸载后响应晚到 → 丢弃（不 setState）
// 4. 竞态：提交后搜索被禁用（关闭对话框）→ 在途响应丢弃
// 5. 边界：空查询 / 仅空格 / rootDir=null / enabled=false → 不调 IPC 且结果为空
// 6. 边界：浏览器模式（无 window.api）→ 不调 IPC、不报错
// 7. 异常：错误信封与异常均触发 onError，且不残留陈旧结果
// 8. onError 经 ref 转发：内联回调不会重置防抖窗口（否则输入期间永不发起请求）
// ──────────────────────────────────────────────────────────────

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileGlobSearch } from '../use-file-glob-search';

const ROOT = '/proj';

/** 默认参数（各用例按需覆盖） */
function makeOptions(overrides: Partial<Parameters<typeof useFileGlobSearch>[0]> = {}) {
  return {
    query: 'app',
    rootDir: ROOT,
    enabled: true,
    debounceMs: 20,
    maxResults: 50,
    onError: vi.fn<() => void>(),
    ...overrides,
  };
}

/** flush 防抖窗口 + 微任务链（真实定时器：用例内延迟设置得很短） */
async function flushDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.search = { glob: vi.fn().mockResolvedValue({ data: { files: [] } }) } as never;
});

describe('useFileGlobSearch', () => {
  describe('正向', () => {
    it('防抖后按契约调用 search:glob 并返回匹配文件', async () => {
      const glob = vi.fn().mockResolvedValue({ data: { files: ['/proj/src/App.tsx'] } });
      window.api.search = { glob } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions()));

      // 防抖窗口内未发起
      expect(glob).not.toHaveBeenCalled();

      await flushDebounce();

      expect(glob).toHaveBeenCalledTimes(1);
      const arg = glob.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg['path']).toBe(ROOT);
      expect(arg['includeHidden']).toBe(false);
      expect(arg['maxResults']).toBe(50);
      // 模式由 lib/file-search 构造：递归通配 + 大小写展开 + 尾通配
      expect(arg['pattern']).toBe('**/*[aA][pP][pP]*');
      expect(result.current).toEqual(['/proj/src/App.tsx']);
    });

    it('查询词首尾空格被 trim 后再构造模式', async () => {
      const glob = vi.fn().mockResolvedValue({ data: { files: [] } });
      window.api.search = { glob } as never;

      renderHook(() => useFileGlobSearch(makeOptions({ query: '  app  ' })));
      await flushDebounce();

      const arg = glob.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg['pattern']).toBe('**/*[aA][pP][pP]*');
    });
  });

  describe('竞态', () => {
    it('查询变化后旧响应晚到：丢弃，不覆盖新查询结果', async () => {
      const resolvers: Array<(value: unknown) => void> = [];
      const glob = vi.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
      window.api.search = { glob } as never;

      const { result, rerender } = renderHook(
        ({ query }: { query: string }) => useFileGlobSearch(makeOptions({ query })),
        { initialProps: { query: 'old' } },
      );
      await flushDebounce();
      expect(glob).toHaveBeenCalledTimes(1);

      // 查询变化 → 上一轮 effect cleanup 置 cancelled
      rerender({ query: 'new' });
      await flushDebounce();
      expect(glob).toHaveBeenCalledTimes(2);

      const firstResolver = resolvers[0];
      const secondResolver = resolvers[1];
      if (firstResolver === undefined || secondResolver === undefined) {
        throw new Error('两次 glob 调用未被捕获');
      }
      // 新查询先返回，随后旧查询才返回
      secondResolver({ data: { files: ['/proj/src/new.ts'] } });
      await waitFor(() => expect(result.current).toEqual(['/proj/src/new.ts']));
      firstResolver({ data: { files: ['/proj/src/stale.ts'] } });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current).toEqual(['/proj/src/new.ts']);
    });

    it('卸载后响应晚到：丢弃（不产生卸载后 setState）', async () => {
      let resolveGlob!: (value: unknown) => void;
      const glob = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveGlob = resolve;
          }),
      );
      window.api.search = { glob } as never;

      const { unmount } = renderHook(() => useFileGlobSearch(makeOptions()));
      await flushDebounce();
      expect(glob).toHaveBeenCalledTimes(1);

      unmount();
      resolveGlob({ data: { files: ['/proj/src/late.ts'] } });
      await act(async () => {
        await Promise.resolve();
      });
      // 无断言目标（结果已随卸载丢弃）；此处断言无异常抛出/无 React 警告即达成
      expect(glob).toHaveBeenCalledTimes(1);
    });

    it('提交后搜索被禁用（对话框关闭）：在途响应丢弃且结果清空', async () => {
      let resolveGlob!: (value: unknown) => void;
      const glob = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveGlob = resolve;
          }),
      );
      window.api.search = { glob } as never;

      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useFileGlobSearch(makeOptions({ enabled })),
        { initialProps: { enabled: true } },
      );
      await flushDebounce();
      expect(glob).toHaveBeenCalledTimes(1);

      rerender({ enabled: false });
      resolveGlob({ data: { files: ['/proj/src/inflight.ts'] } });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current).toEqual([]);
    });
  });

  describe('边界', () => {
    it('空查询：不调 IPC 且结果为空', () => {
      const glob = vi.fn();
      window.api.search = { glob } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions({ query: '' })));

      expect(glob).not.toHaveBeenCalled();
      expect(result.current).toEqual([]);
    });

    it('仅空白查询：视为空（trim 后不搜索）', () => {
      const glob = vi.fn();
      window.api.search = { glob } as never;

      renderHook(() => useFileGlobSearch(makeOptions({ query: '   ' })));

      expect(glob).not.toHaveBeenCalled();
    });

    it('rootDir=null（无激活会话）：不调 IPC', () => {
      const glob = vi.fn();
      window.api.search = { glob } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions({ rootDir: null })));

      expect(glob).not.toHaveBeenCalled();
      expect(result.current).toEqual([]);
    });

    it('enabled=false：不调 IPC（对话框未打开）', () => {
      const glob = vi.fn();
      window.api.search = { glob } as never;

      renderHook(() => useFileGlobSearch(makeOptions({ enabled: false })));

      expect(glob).not.toHaveBeenCalled();
    });

    it('结果含截断提示时只取 files（truncated 由上层不感知）', async () => {
      const glob = vi.fn().mockResolvedValue({
        data: { files: ['/proj/a.ts'], truncated: true },
      });
      window.api.search = { glob } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions()));
      await flushDebounce();

      expect(result.current).toEqual(['/proj/a.ts']);
    });
  });

  describe('异常', () => {
    it('错误信封（unwrap 抛错）：触发 onError 且结果清空（不误读为「无结果」）', async () => {
      const onError = vi.fn<() => void>();
      window.api.search = {
        glob: vi.fn().mockResolvedValue({ error: { code: 'SEARCH_FAILED', message: 'rg down' } }),
      } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions({ onError })));
      await flushDebounce();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(result.current).toEqual([]);
    });

    it('IPC 异常（reject）：同样触发 onError 且结果清空', async () => {
      const onError = vi.fn<() => void>();
      window.api.search = { glob: vi.fn().mockRejectedValue(new Error('ipc down')) } as never;

      const { result } = renderHook(() => useFileGlobSearch(makeOptions({ onError })));
      await flushDebounce();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(result.current).toEqual([]);
    });

    it('onError 经 ref 转发：内联回调不重置防抖窗口（输入期间仍能发起请求）', async () => {
      const glob = vi.fn().mockResolvedValue({ data: { files: [] } });
      window.api.search = { glob } as never;

      // 每次渲染都传入新的内联箭头函数（模拟组件内 `onError: () => toast(...)`）
      const { rerender } = renderHook(
        ({ query }: { query: string }) =>
          useFileGlobSearch({
            query,
            rootDir: ROOT,
            enabled: true,
            debounceMs: 30,
            maxResults: 50,
            onError: () => undefined,
          }),
        { initialProps: { query: 'a' } },
      );

      // 频繁重渲染（回调引用每次都变）不应无限期推迟防抖
      rerender({ query: 'a' });
      rerender({ query: 'a' });
      await flushDebounce();

      expect(glob).toHaveBeenCalledTimes(1);
    });
  });
});
