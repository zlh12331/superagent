// src/renderer/hooks/__tests__/use-file-tree.test.ts
// useFileTree 数据生命周期测试（此前零覆盖）
// ──────────────────────────────────────────────────────────────
// 覆盖（正向 / 边界 / 异常）：
// 1. workingDir 同步 setRootPath + 启动 watch + 根目录加载（IPC 参数契约）
// 2. 默认展开层级链：加载波次后自动注入子目录（defaultExpandDepth）
// 3. watch 事件分流：create → 父目录重载 / delete → removeEntry / rename → 移除+重载
// 4. watcherId 过滤：就绪后异源事件被忽略（多窗口/旧 watcher 残留防串扰）
// 5. 异常：watchStart 错误信封 → watchFailed toast；异常 → watchAbnormal toast
// 6. 边界：workingDir null 不启动；卸载 → watchStop 防泄漏；卸载时 watchStart 在途 → 响应后立即停
// ──────────────────────────────────────────────────────────────

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

import { useFileTree } from '../use-file-tree';

const { mockToastWarning } = vi.hoisted(() => ({ mockToastWarning: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { warning: mockToastWarning, error: vi.fn(), success: vi.fn() },
}));

const ROOT = '/proj';

/** 构造条目（POSIX 路径，与 dirname 实现对齐） */
function entry(name: string, type: 'file' | 'directory' = 'file') {
  return { name, path: `${ROOT}/${name}`, type, size: 0, modifiedAt: 0 };
}

interface WatchEvent {
  type: 'create' | 'delete' | 'rename' | 'modify';
  path: string;
  watcherId?: string;
  oldPath?: string;
}

/** 装配 window.api.file mock，返回事件分发器与各 IPC mock */
function setupApi() {
  const watchHandlers: Array<(event: WatchEvent) => void> = [];
  const list = vi.fn();
  const watchStart = vi.fn();
  const watchStop = vi.fn();
  const unsubscribe = vi.fn();
  window.api.file = {
    list,
    watchStart,
    watchStop,
    subscribeWatchEvent: vi.fn((cb: (event: WatchEvent) => void) => {
      watchHandlers.push(cb);
      return unsubscribe;
    }),
  } as never;
  return { watchHandlers, list, watchStart, watchStop, unsubscribe };
}

/** flush 微任务（watchStart 是异步 IIFE，需先落地 watcherId 再派发事件） */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockToastWarning.mockClear();
  useFileTreeStore.getState().reset();
  useSettingsStore.setState({
    workspace: { ...useSettingsStore.getState().workspace, defaultExpandDepth: 1 },
  });
});

describe('useFileTree 数据生命周期', () => {
  it('正向：同步 rootPath + 启动 watch + 按契约加载根目录条目', async () => {
    const { list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [entry('a.ts')] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });

    renderHook(() => useFileTree(ROOT));

    await waitFor(() =>
      expect(
        useFileTreeStore
          .getState()
          .entries.get(ROOT)
          ?.map((e) => e.name),
      ).toEqual(['a.ts']),
    );
    expect(useFileTreeStore.getState().rootPath).toBe(ROOT);
    // 默认展开根目录
    expect(useFileTreeStore.getState().expandedPaths.has(ROOT)).toBe(true);
    // list IPC 参数契约（与 refreshExpandedDirs 对齐）
    expect(list).toHaveBeenCalledWith({ path: ROOT, depth: 1, includeHidden: false });
    expect(watchStart).toHaveBeenCalledWith({ path: ROOT });
  });

  it('正向：defaultExpandDepth=2 时自动注入子目录展开（层级链）', async () => {
    useSettingsStore.setState({
      workspace: { ...useSettingsStore.getState().workspace, defaultExpandDepth: 2 },
    });
    const { list } = setupApi();
    list.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: { entries: path === ROOT ? [entry('sub', 'directory')] : [] },
      }),
    );
    renderHook(() => useFileTree(ROOT));

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ path: '/proj/sub', depth: 1, includeHidden: false }),
    );
    // 子目录被自动注入展开集
    expect(useFileTreeStore.getState().expandedPaths.has('/proj/sub')).toBe(true);
  });

  it('正向边界：已加载目录不重复请求（loadedDirs 去重）', async () => {
    const { list } = setupApi();
    list.mockResolvedValue({ data: { entries: [] } });
    const { rerender } = renderHook(({ dir }: { dir: string | null }) => useFileTree(dir), {
      initialProps: { dir: ROOT as string | null },
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // 同 workingDir 重渲染：expandedPaths 未变化 → 不重复 list
    rerender({ dir: ROOT });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('watch create：重新加载父目录（重载而非增量，避免漏 stat）', async () => {
    const { watchHandlers, list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [entry('a.ts')] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree(ROOT));
    await flushAsync();
    const callsAfterMount = list.mock.calls.length;

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'create', path: `${ROOT}/b.ts`, watcherId: 'w1' });
      });
    });

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsAfterMount));
    expect(list).toHaveBeenLastCalledWith({ path: ROOT, depth: 1, includeHidden: false });
  });

  it('异常：根目录下的文件（父目录即根）→ 重载根而非把文件路径当目录', async () => {
    // 工作目录为文件系统根：根级文件的父目录应解析为 '/'，
    // 此前 dirname 的 idx<=0 分支把 '/a.ts' 原样返回 → 会对「文件」调 list
    // 并按文件路径查 entries（键不存在，增量更新静默失效）。
    const { watchHandlers, list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree('/'));
    await flushAsync();
    list.mockClear();

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'create', path: '/newfile.ts', watcherId: 'w1' });
      });
    });

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({ path: '/', depth: 1, includeHidden: false });
  });

  it('异常：Windows 盘根下的文件 → 父目录保留尾分隔符（C:\\ 而非 C:）', async () => {
    // workingDir='C:\' 时 store 键是 'C:\'；若 dirname 返回 'C:' 则键失配，
    // 重载写不进 entries、删除也不会命中
    const { watchHandlers, list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree('C:\\'));
    await flushAsync();
    list.mockClear();

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'create', path: 'C:\\newfile.ts', watcherId: 'w1' });
      });
    });

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({ path: 'C:\\', depth: 1, includeHidden: false });
  });

  it('watch delete：removeEntry 增量移除（不触发重载）', async () => {
    const { watchHandlers, list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [entry('a.ts'), entry('b.txt')] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree(ROOT));
    await flushAsync();
    const callsAfterMount = list.mock.calls.length;

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'delete', path: `${ROOT}/a.ts`, watcherId: 'w1' });
      });
    });

    expect(
      useFileTreeStore
        .getState()
        .entries.get(ROOT)
        ?.map((e) => e.name),
    ).toEqual(['b.txt']);
    expect(list.mock.calls.length).toBe(callsAfterMount);
  });

  it('watch rename：旧路径移除 + 父目录重载', async () => {
    const { watchHandlers, list, watchStart } = setupApi();
    // 首次加载返回 old.txt；rename 触发的重载返回 new.txt（模拟磁盘已重命名）
    let listCalls = 0;
    list.mockImplementation(() => {
      listCalls += 1;
      return Promise.resolve({
        data: { entries: [listCalls === 1 ? entry('old.txt') : entry('new.txt')] },
      });
    });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree(ROOT));
    await waitFor(() =>
      expect(
        useFileTreeStore
          .getState()
          .entries.get(ROOT)
          ?.map((e) => e.name),
      ).toEqual(['old.txt']),
    );

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'rename', path: `${ROOT}/new.txt`, oldPath: `${ROOT}/old.txt`, watcherId: 'w1' });
      });
    });

    // 旧路径条目移除后由重载写入磁盘上的新条目
    await waitFor(() =>
      expect(
        useFileTreeStore
          .getState()
          .entries.get(ROOT)
          ?.map((e) => e.name),
      ).toEqual(['new.txt']),
    );
  });

  it('异常边界：watcherId 就绪后，异源事件被过滤（防多窗口串扰）', async () => {
    const { watchHandlers, list, watchStart } = setupApi();
    list.mockResolvedValue({ data: { entries: [entry('a.ts')] } });
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    renderHook(() => useFileTree(ROOT));
    await flushAsync();
    const callsAfterMount = list.mock.calls.length;

    await act(async () => {
      watchHandlers.forEach((h) => {
        h({ type: 'create', path: `${ROOT}/x.ts`, watcherId: 'w-other' });
      });
    });
    await act(async () => {});

    expect(list.mock.calls.length).toBe(callsAfterMount);
  });

  it('异常：watchStart 返回错误信封 → watchFailed 提示（可刷新重试）', async () => {
    const { watchStart } = setupApi();
    watchStart.mockResolvedValue({ error: { code: 'WATCH_FAILED', message: 'denied' } });

    renderHook(() => useFileTree(ROOT));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(mockToastWarning).toHaveBeenCalledWith(
      i18n.t('common.watchFailed'),
      expect.objectContaining({ description: i18n.t('common.watchFailedDesc') }),
    );
  });

  it('异常：watchStart 抛非错误信封异常 → watchAbnormal 提示', async () => {
    const { watchStart } = setupApi();
    watchStart.mockRejectedValue(new Error('boom'));

    renderHook(() => useFileTree(ROOT));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(mockToastWarning).toHaveBeenCalledWith(
      i18n.t('common.watchAbnormal'),
      expect.objectContaining({ description: i18n.t('common.watchAbnormalDesc') }),
    );
  });

  it('边界：workingDir=null → 不启动 watch、不加载、rootPath 为 null', () => {
    const { list, watchStart } = setupApi();
    renderHook(() => useFileTree(null));

    expect(useFileTreeStore.getState().rootPath).toBeNull();
    expect(watchStart).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('边界：卸载 → watchStop 防泄漏 + 取消事件订阅', async () => {
    const { watchStart, watchStop, unsubscribe } = setupApi();
    watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
    const { unmount } = renderHook(() => useFileTree(ROOT));
    await flushAsync();

    unmount();

    expect(watchStop).toHaveBeenCalledWith({ watcherId: 'w1' });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('边界：卸载时 watchStart 仍在途 → 响应到达后立即停止（无泄漏）', async () => {
    const { watchStart, watchStop } = setupApi();
    let resolveStart!: (value: unknown) => void;
    watchStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { unmount } = renderHook(() => useFileTree(ROOT));
    unmount();
    resolveStart({ data: { watcherId: 'w1' } });
    await flushAsync();

    expect(watchStop).toHaveBeenCalledWith({ watcherId: 'w1' });
  });

  describe('refresh（手动重拉根目录 + 已展开目录）', () => {
    it('正向：重拉根目录与已展开目录的条目（写入 store，去重后每目录一次）', async () => {
      const { list, watchStart } = setupApi();
      list.mockResolvedValue({ data: { entries: [entry('a.ts')] } });
      watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
      const { result } = renderHook(() => useFileTree(ROOT));
      await flushAsync();

      // 展开一个子目录 → 触发一次 list；再手动刷新应覆盖「根 + 子目录」
      list.mockClear();
      useFileTreeStore.getState().setExpanded(`${ROOT}/sub`, true);
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

      list.mockResolvedValue({
        data: { entries: [entry('fresh.ts')] },
      });
      list.mockClear();
      result.current.refresh();

      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const calledPaths = list.mock.calls.map((c) => (c[0] as { path: string }).path).sort();
      expect(calledPaths).toEqual([ROOT, `${ROOT}/sub`]);
      await waitFor(() =>
        expect(
          useFileTreeStore
            .getState()
            .entries.get(ROOT)
            ?.map((e) => e.name),
        ).toEqual(['fresh.ts']),
      );
    });

    it('正向：全部成功不弹提示', async () => {
      const { list, watchStart } = setupApi();
      list.mockResolvedValue({ data: { entries: [] } });
      watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
      const { result } = renderHook(() => useFileTree(ROOT));
      await flushAsync();
      mockToastWarning.mockClear();

      result.current.refresh();
      await waitFor(() => expect(mockToastWarning).not.toHaveBeenCalled());
    });

    it('异常：任一目录失败 → 集中提示一次 refreshFailed（不中断其余目录）', async () => {
      const { list, watchStart } = setupApi();
      list.mockImplementation(({ path }: { path: string }) =>
        path === ROOT
          ? Promise.resolve({ data: { entries: [] } })
          : Promise.reject(new Error('denied')),
      );
      watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
      const { result } = renderHook(() => useFileTree(ROOT));
      await flushAsync();
      useFileTreeStore.getState().setExpanded(`${ROOT}/bad`, true);
      await waitFor(() =>
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ path: `${ROOT}/bad` })),
      );
      mockToastWarning.mockClear();

      result.current.refresh();

      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      expect(mockToastWarning).toHaveBeenCalledWith(i18n.t('fileTree.refreshFailed'));
    });

    it('边界：workingDir=null 时 refresh no-op（不调 IPC）', () => {
      const { list } = setupApi();
      const { result } = renderHook(() => useFileTree(null));

      result.current.refresh();

      expect(list).not.toHaveBeenCalled();
    });

    it('边界：调用瞬间桥缺失（无 window.api）→ 视为全部成功，不误报失败', async () => {
      const { list, watchStart } = setupApi();
      list.mockResolvedValue({ data: { entries: [] } });
      watchStart.mockResolvedValue({ data: { watcherId: 'w1' } });
      const { result } = renderHook(() => useFileTree(ROOT));
      await flushAsync();

      // 仅在 refresh 调用期间移除桥（模拟桥不可用），随后立即恢复——
      // 否则卸载时的 watchStop 清理会命中 undefined（与本用例无关的路径）
      const savedApi = window.api;
      (window as unknown as { api: undefined }).api = undefined;
      // 清掉挂载期的根目录加载，使断言只反映本次 refresh 的调用
      list.mockClear();
      mockToastWarning.mockClear();
      result.current.refresh();
      await flushAsync();
      (window as unknown as { api: typeof savedApi }).api = savedApi;

      // 守卫直接返回 0（全部成功语义）→ 不调 IPC、不弹提示
      expect(list).not.toHaveBeenCalled();
      expect(mockToastWarning).not.toHaveBeenCalled();
    });
  });
});
