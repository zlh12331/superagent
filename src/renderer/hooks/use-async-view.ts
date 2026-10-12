import type { UseQueryResult } from '@tanstack/react-query';

/**
 * 异步视图状态（discriminated union，即轻量状态机）
 *
 * 消费方用 switch(view.state) 处理，TS 会强制覆盖全部状态。
 */
export type AsyncView<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'refreshing'; readonly data: T }
  | {
      readonly state: 'error';
      readonly error: Error;
      readonly retry: () => void;
      readonly data?: T;
    }
  | { readonly state: 'empty' }
  | { readonly state: 'ready'; readonly data: T };

/** useAsyncView 配置 */
export interface UseAsyncViewOptions<T> {
  /**
   * 空态谓词：加载成功后据此判定是否为空。
   * 交由调用方配置，避免"空数组/null 算不算空"的歧义。
   */
  readonly isEmpty: (data: T) => boolean;
}

/**
 * 把 TanStack Query 结果映射为 AsyncView 视图状态。
 *
 * 关键行为：
 * - 后台刷新（success + fetching）→ refreshing，保留旧数据
 * - 失败时保留上一次成功数据（TanStack Query 在 refetch 失败后仍持有 data）
 * - retry 复用 query.refetch（自动重试由 Query 配置负责，此为手动兜底）
 *
 * @param query useQuery 的返回值
 * @param options 空态谓词等配置
 */
export function useAsyncView<T>(
  query: UseQueryResult<T, Error>,
  options: UseAsyncViewOptions<T>,
): AsyncView<T> {
  const { status, fetchStatus, data, error, refetch } = query;

  if (status === 'success' && data !== undefined) {
    if (fetchStatus === 'fetching') {
      return { state: 'refreshing', data };
    }
    if (options.isEmpty(data)) {
      return { state: 'empty' };
    }
    return { state: 'ready', data };
  }

  if (status === 'error') {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const retry = (): void => {
      void refetch();
    };
    if (data !== undefined) {
      return { state: 'error', error: normalizedError, retry, data };
    }
    return { state: 'error', error: normalizedError, retry };
  }

  return { state: 'loading' };
}
