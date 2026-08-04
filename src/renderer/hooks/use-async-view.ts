// src/renderer/hooks/use-async-view.ts
// 异步视图状态契约层（L3 服务端数据 → 视图状态机）
// ──────────────────────────────────────────────────────────────
// 设计动机：
// - 组件里散落 `if isLoading / if error / if empty` 的 if 链，各写各的，
//   骨架屏样式、错误处理、空态行为互不一致。
// - 本 hook 把 TanStack Query 结果映射为一个 discriminated union（AsyncView），
//   这即"轻量状态机"：TS 穷尽性检查强制消费方处理每个状态。
// - 渲染由 AsyncBoundary 组件负责（见 components/common/AsyncBoundary.tsx）。
//
// 五态语义：
// - loading    首次加载、无数据（渲染骨架屏，配合 skeletonDelay 防闪烁）
// - refreshing 已有数据、后台刷新（保留旧数据，绝不闪骨架屏）
// - error      加载失败（保留上一次成功数据 + 可操作重试）
// - empty      加载成功但为空（由 isEmpty 谓词判定）
// - ready      加载成功且有数据
// ──────────────────────────────────────────────────────────────

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

  // 成功（含后台刷新）
  if (status === 'success' && data !== undefined) {
    if (fetchStatus === 'fetching') {
      return { state: 'refreshing', data };
    }
    if (options.isEmpty(data)) {
      return { state: 'empty' };
    }
    return { state: 'ready', data };
  }

  // 失败：保留可能存在的旧数据，retry 指向 refetch
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

  // pending：尚无数据（首次加载）
  return { state: 'loading' };
}
