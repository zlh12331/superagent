// src/renderer/hooks/__tests__/use-git.test.tsx
// use-git 单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. GIT_STATUS_QUERY_KEY：返回 ['git', 'status', path] 常量
// 2. useGitStatusQuery：
//    - 成功：data 返回 GitStatusRes
//    - 错误：IpcResponse.error 分支 → throw + Query 进入 isError
//    - enabled=false：不发起请求
// 3. useGitDiffQuery：
//    - 成功：data 返回 GitDiffRes
//    - 错误：IpcResponse.error 分支 → throw
//    - enabled=false：不发起请求
//    - 默认 ref='HEAD', staged=false
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GIT_STATUS_QUERY_KEY, useGitDiffQuery, useGitStatusQuery } from '../use-git';

// ── 测试工具：创建 QueryClient wrapper ────────────────────────
//
// TanStack Query hooks 需要 QueryClientProvider 包裹才能使用
// retries: 0 让错误立即返回（不重试，避免测试超时）
//
// 注意：children 类型用 ReactNode（而非 ReactElement），
// React 19 升级后 QueryClientProvider 的 children 类型为 ReactNode（包含 undefined）
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });

  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

// ── 测试数据 fixture ──────────────────────────────────────────

const mockGitStatusRes = {
  branch: 'master',
  ahead: 2,
  behind: 1,
  files: [{ path: 'src/main.ts', status: 'modified' as const, staged: false }],
  clean: false,
};

const mockGitDiffRes = {
  diff: '+added line\n-removed line',
  additions: 1,
  deletions: 1,
  filesChanged: 1,
};

describe('use-git hooks', () => {
  beforeEach(() => {
    // 重置 window.api.git
    window.api.git = {
      status: vi.fn(),
      diff: vi.fn(),
    } as never;
  });

  // ── GIT_STATUS_QUERY_KEY ───────────────────────────────
  describe('GIT_STATUS_QUERY_KEY', () => {
    it("返回 ['git', 'status', path] 元组", () => {
      const key = GIT_STATUS_QUERY_KEY('/repo');
      expect(key).toEqual(['git', 'status', '/repo']);
      // as const 保证是 tuple，不是普通数组
      expect(Array.isArray(key)).toBe(true);
    });

    it('不同路径生成不同 key', () => {
      expect(GIT_STATUS_QUERY_KEY('/repo-a')).not.toEqual(GIT_STATUS_QUERY_KEY('/repo-b'));
    });
  });

  // ── useGitStatusQuery ─────────────────────────────────
  describe('useGitStatusQuery', () => {
    it('成功：返回 GitStatusRes', async () => {
      (window.api.git.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitStatusRes,
      });

      const { result } = renderHook(() => useGitStatusQuery('/repo'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(result.current.data).toEqual(mockGitStatusRes);
      // 验证 IPC 调用参数
      expect(window.api.git.status).toHaveBeenCalledWith({ path: '/repo' });
    });

    it('错误：IpcResponse.error 分支 → Query 进入 isError', async () => {
      (window.api.git.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        error: { code: 'GIT_ERROR', message: 'not a git repository' },
      });

      const { result } = renderHook(() => useGitStatusQuery('/invalid'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });
      // 错误信息格式：[CODE] message
      expect(result.current.error?.message).toBe('[GIT_ERROR] not a git repository');
    });

    it('enabled=false：不发起请求', async () => {
      (window.api.git.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitStatusRes,
      });

      const { result } = renderHook(() => useGitStatusQuery('/repo', false), {
        wrapper: createWrapper(),
      });

      // enabled=false 时不会 fetch
      expect(result.current.fetchStatus).toBe('idle');
      expect(window.api.git.status).not.toHaveBeenCalled();
    });

    it('缓存：相同 path 共享同一 queryKey', async () => {
      (window.api.git.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitStatusRes,
      });

      // 第一次 hook
      const wrapper = createWrapper();
      const { result: result1, unmount: unmount1 } = renderHook(() => useGitStatusQuery('/repo'), {
        wrapper,
      });
      await waitFor(() => {
        expect(result1.current.isSuccess).toBe(true);
      });
      unmount1();

      // 第二次 hook（相同 path）应使用缓存（staleTime=10s 内）
      const { result: result2 } = renderHook(() => useGitStatusQuery('/repo'), {
        wrapper,
      });
      await waitFor(() => {
        expect(result2.current.isSuccess).toBe(true);
      });

      // 只应调用一次 IPC（第二次走缓存）
      expect(window.api.git.status).toHaveBeenCalledTimes(1);
    });
  });

  // ── useGitDiffQuery ───────────────────────────────────
  describe('useGitDiffQuery', () => {
    it('成功：返回 GitDiffRes', async () => {
      (window.api.git.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitDiffRes,
      });

      const { result } = renderHook(
        () =>
          useGitDiffQuery(
            { path: '/repo', ref: 'HEAD', staged: false, filePath: 'src/main.ts' },
            true,
          ),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(result.current.data).toEqual(mockGitDiffRes);
      expect(window.api.git.diff).toHaveBeenCalledWith({
        path: '/repo',
        ref: 'HEAD',
        staged: false,
        filePath: 'src/main.ts',
      });
    });

    it('错误：IpcResponse.error 分支 → Query 进入 isError', async () => {
      (window.api.git.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
        error: { code: 'GIT_DIFF_ERROR', message: 'diff failed' },
      });

      const { result } = renderHook(
        () =>
          useGitDiffQuery(
            { path: '/repo', ref: 'HEAD', staged: false, filePath: 'unknown.ts' },
            true,
          ),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });
      expect(result.current.error?.message).toBe('[GIT_DIFF_ERROR] diff failed');
    });

    it('enabled=false：不发起请求', async () => {
      (window.api.git.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitDiffRes,
      });

      const { result } = renderHook(
        () =>
          useGitDiffQuery(
            { path: '/repo', ref: 'HEAD', staged: false, filePath: 'src/main.ts' },
            false,
          ),
        { wrapper: createWrapper() },
      );

      expect(result.current.fetchStatus).toBe('idle');
      expect(window.api.git.diff).not.toHaveBeenCalled();
    });

    it('默认参数：未指定 ref/staged 时使用 HEAD/false', async () => {
      (window.api.git.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitDiffRes,
      });

      // exactOptionalPropertyTypes: 可选属性 ref/staged 不允许显式传 undefined
      // 省略字段时，queryFn 内部通过 ?? 兜底为 'HEAD'/false
      const { result } = renderHook(
        () =>
          useGitDiffQuery(
            // biome-ignore lint/suspicious/noExplicitAny: 测试用 any 简化 exactOptionalPropertyTypes 问题
            { path: '/repo', filePath: undefined } as any,
            true,
          ),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      // queryFn 内部使用 ?? 兜底：ref='HEAD', staged=false, filePath=undefined
      expect(window.api.git.diff).toHaveBeenCalledWith({
        path: '/repo',
        ref: 'HEAD',
        staged: false,
        filePath: undefined,
      });
    });

    it('staleTime=0：每次调用都重新请求（不缓存）', async () => {
      (window.api.git.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGitDiffRes,
      });

      const wrapper = createWrapper();
      const { result: r1, unmount: u1 } = renderHook(
        () =>
          useGitDiffQuery({ path: '/repo', ref: 'HEAD', staged: false, filePath: 'a.ts' }, true),
        { wrapper },
      );
      await waitFor(() => {
        expect(r1.current.isSuccess).toBe(true);
      });
      u1();

      const { result: r2 } = renderHook(
        () =>
          useGitDiffQuery({ path: '/repo', ref: 'HEAD', staged: false, filePath: 'a.ts' }, true),
        { wrapper },
      );
      await waitFor(() => {
        expect(r2.current.isSuccess).toBe(true);
      });

      // staleTime=0：第二次也应重新请求
      expect(window.api.git.diff).toHaveBeenCalledTimes(2);
    });
  });
});
