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
    readonly filePath: string | undefined;
  },
  enabled = true,
) {
  return useQuery({
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
    staleTime: 0,
  });
}

/**
 * 类型导出（从 query result 派生）
 *
 * 业务方从此处导入 Git 类型，避免直接依赖 shared 包。
 */
export type { GitDiffRes, GitFileStatus, GitStatusRes } from '@code-agent/shared/renderer';
