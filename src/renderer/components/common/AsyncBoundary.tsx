// src/renderer/components/common/AsyncBoundary.tsx
// 异步视图渲染层（AsyncView 状态 → UI）
// ──────────────────────────────────────────────────────────────
// 与契约层 useAsyncView 配套：
// - useAsyncView 把 TanStack Query 结果映射为 AsyncView（状态机）
// - AsyncBoundary 把 AsyncView 渲染为 骨架屏 / 错误(可操作) / 空态 / 内容
//
// 设计要点：
// - 防闪烁：首次加载延迟 skeletonDelay（默认 200ms）才显示骨架屏，
//   快请求直接 null→内容，避免骨架屏一闪而过。
// - 后台刷新（refreshing）保留旧数据渲染，绝不闪骨架屏。
// - 错误态默认可操作：本地化错误文案 + 重试按钮；调用方可传 errorHint
//   按错误码定制动作（如 AI_CONFIG_ERROR → 打开设置）。
// - 可访问性：loading 有 aria-busy / role="status"，error 有 role="alert"。
// ──────────────────────────────────────────────────────────────

import { AlertTriangle, RefreshCw, Settings2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { AsyncView } from '@/hooks/use-async-view';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { resolveErrorAction } from '@/lib/error-actions';
import { unwrapErrorMessage } from '@/lib/ipc';
import { useUiStore } from '@/stores/transient/ui-store';

/** 默认骨架屏延迟（毫秒）：低于此时长的首次加载不显示骨架屏，防闪烁 */
const DEFAULT_SKELETON_DELAY = 200;

interface AsyncBoundaryProps<T> {
  /** useAsyncView 的返回值（视图状态机） */
  readonly view: AsyncView<T>;
  /** 首次加载骨架屏（形状应匹配内容布局，避免跳动） */
  readonly skeleton: ReactNode;
  /** 空态（推荐用 EmptyState，可带 CTA） */
  readonly empty: ReactNode;
  /** 成功态渲染（ready / refreshing 均用 data 渲染，refreshing 保留旧数据） */
  readonly children: (data: T) => ReactElement;
  /** 骨架屏延迟（毫秒），默认 200；传 0 立即显示 */
  readonly skeletonDelay?: number;
  /**
   * 自定义错误渲染（可操作）。未提供时用默认：本地化文案 + 重试按钮。
   * data 为失败前保留的旧数据（可能为 undefined）。
   */
  readonly errorHint?: (error: Error, retry: () => void, data: T | undefined) => ReactNode;
}

/**
 * 异步视图边界组件
 *
 * @example
 * ```tsx
 * const query = useSessionsQuery();
 * const view = useAsyncView(query, { isEmpty: (d) => d.sessions.length === 0 });
 * return (
 *   <AsyncBoundary
 *     view={view}
 *     skeleton={<SessionListSkeleton />}
 *     empty={<EmptyState title={t('sidebar.noSessions')} actionLabel={t('common.retry')} onAction={...} />}
 *   >
 *     {(data) => <SessionList sessions={data.sessions} />}
 *   </AsyncBoundary>
 * );
 * ```
 */
export function AsyncBoundary<T>({
  view,
  skeleton,
  empty,
  children,
  skeletonDelay = DEFAULT_SKELETON_DELAY,
  errorHint,
}: AsyncBoundaryProps<T>): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  // 全局 UI store：错误码恢复动作（如「去配置」）打开设置对话框
  const openSettings = useUiStore((state) => state.openSettings);

  // 从 Error 解析本地化文案：约定错误格式为 "[CODE] message"（见 lib/ipc unwrap）；
  // 解析收敛至 unwrapErrorMessage 单一真源（含 localize 抛错回退）
  const resolveErrorMessage = (error: Error): string => unwrapErrorMessage(error, getErrorMessage);

  // 防闪烁：仅在 loading 持续超过 skeletonDelay 后才显示骨架屏
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (view.state !== 'loading') {
      setShowSkeleton(false);
      return;
    }
    if (skeletonDelay <= 0) {
      setShowSkeleton(true);
      return;
    }
    const timer = setTimeout(() => setShowSkeleton(true), skeletonDelay);
    return () => clearTimeout(timer);
  }, [view.state, skeletonDelay]);

  switch (view.state) {
    case 'loading':
      return (
        <div aria-busy="true" role="status">
          {showSkeleton ? skeleton : null}
        </div>
      );

    case 'refreshing':
      // 后台刷新：保留旧数据渲染，不闪骨架屏；
      // 顶部细进度条指示刷新中（indeterminate 滑动，aria-hidden 不干扰读屏）
      return (
        <div className="relative">
          <div aria-hidden="true" data-testid="refreshing-bar" className="async-refreshing-bar" />
          {children(view.data)}
        </div>
      );

    case 'error': {
      if (errorHint !== undefined) {
        return <>{errorHint(view.error, view.retry, view.data)}</>;
      }
      // 错误码 → 恢复动作（如 API Key 缺失 → 打开设置）
      const action = resolveErrorAction(view.error);
      return (
        <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3 p-6">
          <AlertTriangle className="text-destructive size-8" strokeWidth={1.5} />
          <p className="text-muted-foreground text-sm">{resolveErrorMessage(view.error)}</p>
          <div className="flex gap-2">
            {action !== undefined && action.kind === 'open-settings' && (
              <Button variant="outline" size="sm" onClick={() => openSettings()}>
                <Settings2 className="size-3.5" strokeWidth={2} />
                {t('common.goToSettings')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={view.retry}>
              <RefreshCw className="size-3.5" strokeWidth={2} />
              {t('common.retry')}
            </Button>
          </div>
        </div>
      );
    }

    case 'empty':
      return <>{empty}</>;

    case 'ready':
      return children(view.data);
  }
}
