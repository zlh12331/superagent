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
  const openSettings = useUiStore((state) => state.openSettings);

  const resolveErrorMessage = (error: Error): string => unwrapErrorMessage(error, getErrorMessage);

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
