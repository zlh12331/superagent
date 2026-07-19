// src/renderer/hooks/use-ipc-query.ts
// IPC 查询 hook（TanStack Query 包装）
// 设计文档 §5.1 场景 1 渲染层读数据
//
// 用法：
//   const { data, isLoading, error } = useIpcQuery({
//     queryKey: queryKeys.projects.list(),
//     queryFn: () => unwrap(apiClient.project.list()),
//   });

import type { IpcResponse } from '@novel-writer/shared';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { unwrap } from '@/api/client';

/**
 * IPC 查询 hook：包装 useQuery，自动用 unwrap 解包 IpcResponse
 *
 * @param opts.queryKey - TanStack Query 缓存 key（来自 queryKeys 工厂）
 * @param opts.queryFn - 返回 IpcResponse 的 IPC 调用（无需手动 unwrap）
 * @param opts.enabled - 是否启用查询（默认 true）
 * @returns UseQueryResult<TData, Error>，data 已是解包后的业务数据
 *
 * @example
 * const { data, isLoading } = useIpcQuery({
 *   queryKey: queryKeys.projects.list(),
 *   queryFn: () => apiClient.project.list(),
 * });
 */
// biome-ignore lint/style/useNamingConvention: TData 为 TS 泛型惯例
export function useIpcQuery<TData>(opts: {
  queryKey: ReadonlyArray<unknown>;
  queryFn: () => Promise<IpcResponse<TData>>;
  enabled?: boolean;
}): UseQueryResult<TData, Error> {
  // 显式指定泛型 <TData, Error>，让 TError = Error（默认 DefaultError 也是 Error 子类）
  // queryFn 内部自动 unwrap，调用方无需手动处理 IpcResponse
  return useQuery<TData, Error>({
    queryKey: opts.queryKey,
    queryFn: async () => unwrap<TData>(await opts.queryFn()),
    enabled: opts.enabled ?? true,
  });
}
