// src/renderer/hooks/use-git.ts
// Git 数据查询 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 git:status / git:diff IPC
// - 自动处理缓存失效 + 竞态 + 重试（QueryClient 默认配置）
// - 仅封装只读操作（Git 域设计上不提供 commit/push 等写操作）
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - git:status / git:diff 为 IPC invoke（请求-响应），使用 TanStack Query 缓存
// - 不缓存 diff（因 diff 可能针对不同 ref/staged/filePath 组合，缓存键复杂且
//   重复查询频率低，且 diff 文本可能较大，避免占用缓存空间）
//
// 缓存策略：
// - queryKey: ['git', 'status', path] - 工作区状态（按仓库路径缓存）
// - staleTime: 10s（Git 状态变化较快，避免长时间展示过期数据）
// - 不缓存 diff：每次调用都重新请求
// ──────────────────────────────────────────────────────────────

import type { GitDiffRes, GitStatusRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';

import { unwrap } from '@/lib/ipc';

/**
 * Query key 常量（避免手写字符串导致 typo）
 *
 * ['git', 'status', path] - 工作区状态（按仓库路径区分）
 */
export const GIT_STATUS_QUERY_KEY = (path: string) => ['git', 'status', path] as const;

/**
 * ['git', 'diff', path, ref, staged, filePath] - 工作区 diff
 *
 * diff 不缓存（每次重新请求），此 key 仅用于 TanStack 内部状态管理；
 * 仍以常量形式集中定义，避免与 QUERY_KEY_ROOTS.git 的前缀失效语义脱节。
 */
export const GIT_DIFF_QUERY_KEY = (params: {
  readonly path: string;
  readonly ref?: string;
  readonly staged?: boolean;
  readonly filePath: string | undefined;
}) =>
  [
    'git',
    'diff',
    params.path,
    params.ref ?? 'HEAD',
    params.staged ?? false,
    params.filePath ?? '',
  ] as const;

/** Git 状态默认 staleTime：10 秒（状态变化较快，避免过期数据） */
const GIT_STATUS_STALE_TIME = 10_000;

/**
 * Git 工作区状态查询 hook
 *
 * 调用 git:status IPC 获取当前分支、ahead/behind、变更文件列表。
 * 仅查询指定路径的 Git 仓库状态。
 *
 * @param path Git 仓库路径（绝对路径，可为仓库根或子目录）
 * @param enabled 是否启用查询（默认 true，可用于禁用未激活面板的查询）
 * @returns TanStack Query 结果（data / isLoading / error / refetch 等）
 *
 * @example
 * ```tsx
 * const { data: status, isLoading } = useGitStatusQuery(repoPath, isPanelVisible);
 * if (isLoading) return <Loading />;
 * return <GitStatusView status={status} />;
 * ```
 */
export function useGitStatusQuery(path: string, enabled = true) {
  return useQuery({
    queryKey: GIT_STATUS_QUERY_KEY(path),
    queryFn: async (): Promise<GitStatusRes> => {
      const response = await window.api.git.status({ path });
      return unwrap(response);
    },
    enabled,
    staleTime: GIT_STATUS_STALE_TIME,
  });
}

/**
 * Git diff 查询 hook
 *
 * 调用 git:diff IPC 获取 unified diff 文本 + 结构化统计。
 * 不缓存：每次调用都重新请求（diff 参数组合多，且文本可能较大）。
 *
 * @param params 查询参数
 * @param params.path Git 仓库路径（绝对路径）
 * @param params.ref 对比的 ref（默认 'HEAD'）
 * @param params.staged 是否只看暂存区（git diff --cached）
 * @param params.filePath 指定文件路径（可选，省略时查看整个仓库 diff）
 * @param enabled 是否启用查询
 * @returns TanStack Query 结果
 *
 * @example
 * ```tsx
 * const { data: diff } = useGitDiffQuery(
 *   { path: repoPath, ref: 'HEAD', staged: false, filePath: selectedFile },
 *   !!selectedFile,
 * );
 * ```
 */
export function useGitDiffQuery(
  params: {
    readonly path: string;
    readonly ref?: string;
    readonly staged?: boolean;
    // exactOptionalPropertyTypes：可选属性不允许显式 undefined，此处允许
    // 因 GitPanel 会传入 selectedFilePath ?? undefined
    readonly filePath: string | undefined;
  },
  enabled = true,
) {
  return useQuery({
    // diff 不缓存：每次都重新请求，queryKey 仅用于 TanStack 内部状态管理
    queryKey: GIT_DIFF_QUERY_KEY(params),
    queryFn: async (): Promise<GitDiffRes> => {
      const response = await window.api.git.diff({
        path: params.path,
        ref: params.ref ?? 'HEAD',
        staged: params.staged ?? false,
        filePath: params.filePath,
      });
      return unwrap(response);
    },
    enabled,
    // 不缓存 diff：staleTime=0 让 Query 每次都重新请求
    staleTime: 0,
  });
}

/**
 * 类型导出（从 query result 派生）
 *
 * 业务方从此处导入 Git 类型，避免直接依赖 shared 包。
 */
export type { GitDiffRes, GitFileStatus, GitStatusRes } from '@code-agent/shared/renderer';
