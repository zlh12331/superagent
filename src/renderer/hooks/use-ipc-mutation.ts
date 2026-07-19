// src/renderer/hooks/use-ipc-mutation.ts
// IPC 变更 hook（TanStack Query Mutation 包装）
// 设计文档 §5.1 场景 2 渲染层写数据 + §4.11 Mutation 失效
//
// 用法：
//   const { mutateAsync } = useIpcMutation({
//     mutationFn: (input) => unwrap(apiClient.project.create(input)),
//     onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.list() }),
//   });

import type { IpcResponse } from '@novel-writer/shared';
import { type UseMutationResult, useMutation } from '@tanstack/react-query';

import { unwrap } from '@/api/client';
import { handleIpcError } from '@/lib/handle-ipc-error';

/**
 * IPC 变更 hook：包装 useMutation，自动用 unwrap 解包 IpcResponse
 *
 * 默认 onError 调用 handleIpcError 显示 toast，调用方可覆盖
 *
 * @param opts.mutationFn - 返回 IpcResponse 的 IPC 调用（无需手动 unwrap）
 * @param opts.onSuccess - 成功回调（如 invalidateQueries）
 * @param opts.onError - 失败回调（默认调 handleIpcError）
 * @returns UseMutationResult<TData, Error, TVariables, unknown>
 *
 * @example
 * const { mutateAsync } = useIpcMutation({
 *   mutationFn: (input) => apiClient.project.create(input),
 *   onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.list() }),
 * });
 */
// biome-ignore lint/style/useNamingConvention: TData/TVariables 为 TS 泛型惯例
export function useIpcMutation<TData, TVariables>(opts: {
  mutationFn: (vars: TVariables) => Promise<IpcResponse<TData>>;
  onSuccess?: (data: TData, vars: TVariables) => void;
  onError?: (err: Error, vars: TVariables) => void;
}): UseMutationResult<TData, Error, TVariables, unknown> {
  return useMutation<TData, Error, TVariables, unknown>({
    mutationFn: async (vars) => unwrap<TData>(await opts.mutationFn(vars)),
    onSuccess: (data, vars) => opts.onSuccess?.(data, vars),
    onError: (err, vars) => {
      // 调用方提供 onError 则用之，否则默认调 handleIpcError 显示 toast
      if (opts.onError !== undefined) {
        opts.onError(err, vars);
      } else {
        handleIpcError(err);
      }
    },
  });
}
