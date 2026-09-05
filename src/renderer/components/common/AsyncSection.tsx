// src/renderer/components/common/AsyncSection.tsx
// 设置分区/面板级数据四态包装器（loading / error / empty / ready）
// ──────────────────────────────
// 背景：铁律 6.2/6.7 要求含异步数据的组件具备 loading 与 error 态并有重试；
// 此前除 AsyncBoundary（侧栏全量五态）外，settings 各 section 的 useQuery
// 普遍缺失 error 分支 —— 请求失败被静默渲染成「空列表」，误导用户。
//
// 定位：轻量行内四态（区别于 AsyncBoundary 的骨架屏五态全量契约），
// 适用于设置分区、右面板列表等小体量数据块。
//
// 用法：
//   const q = useQuery(...);
//   <AsyncSection isPending={q.isPending} isError={q.isError}
//     onRetry={() => void q.refetch()} isEmpty={(q.data ?? []).length === 0}
//     emptyText={t('xxx.empty')}>
//     {(q.data ?? []).map(...)}
//   </AsyncSection>
// 可访问性：error 态 role="alert" 即时播报；pending 态 Spinner 自带 role="status"
// ──────────────────────────────

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

export interface AsyncSectionProps {
  /** 首次加载 / 无缓存刷新中 */
  readonly isPending: boolean;
  /** 查询失败（IpcResponse.error → throw 后进入） */
  readonly isError: boolean;
  /** 失败详情（展示在固定提示之后，title 提示完整内容） */
  readonly errorMessage?: string | null;
  /** 数据为空（由调用方以业务语义判定，如 length === 0） */
  readonly isEmpty: boolean;
  /** 空态文案（已翻译）；缺省且 isEmpty 时不渲染任何内容 */
  readonly emptyText?: string;
  /** 重试回调（缺省时不渲染重试按钮） */
  readonly onRetry?: () => void;
  /** ready 数据渲染 */
  readonly children: ReactNode;
}

/** 错误警示行（async 查询失败时插入大块渲染区之前，无需搬家原有结构） */
export interface QueryErrorRowProps {
  readonly isError: boolean;
  readonly errorMessage?: string | null;
  readonly onRetry?: () => void;
}

/** 非 error 时渲染 null，可直接嵌在 JSX 任意位置 */
export function QueryErrorRow({
  isError,
  errorMessage,
  onRetry,
}: QueryErrorRowProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (!isError) return null;
  return (
    <div
      className="text-error-text mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      role="alert"
    >
      <span>{t('common.sectionLoadFailed')}</span>
      {errorMessage !== undefined && errorMessage !== null && errorMessage !== '' && (
        <span
          className="text-muted-foreground max-w-full truncate font-mono text-2xs"
          title={errorMessage}
        >
          {errorMessage}
        </span>
      )}
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-2xs" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

/** 加载警示行（pending 时插入大块渲染区之前，与 QueryErrorRow 同款行内形态） */
export function QueryPendingRow({ isPending }: { isPending: boolean }): React.ReactElement | null {
  const { t } = useTranslation();
  if (!isPending) return null;
  return (
    <div className="text-muted-foreground mt-2 flex items-center gap-2 text-xs" role="status">
      <Spinner className="size-3.5" />
      {t('common.loading')}
    </div>
  );
}
/** 外层统一间距与字号的四态容器 */

const WRAPPER_CLASS = 'mt-2 text-xs leading-relaxed';

export function AsyncSection({
  isPending,
  isError,
  errorMessage,
  isEmpty,
  emptyText,
  onRetry,
  children,
}: AsyncSectionProps): React.ReactElement | null {
  const { t } = useTranslation();

  if (isPending) {
    return (
      <div className={cn(WRAPPER_CLASS, 'text-muted-foreground flex items-center gap-1.5')}>
        <Spinner className="size-3" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className={cn(WRAPPER_CLASS, 'text-error-text flex flex-wrap items-center gap-x-2 gap-y-1')}
        role="alert"
      >
        <span>{t('common.sectionLoadFailed')}</span>
        {errorMessage !== undefined && errorMessage !== null && errorMessage !== '' && (
          <span
            className="text-muted-foreground max-w-full truncate font-mono text-2xs"
            title={errorMessage}
          >
            {errorMessage}
          </span>
        )}
        {onRetry !== undefined && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-2xs"
            onClick={onRetry}
          >
            {t('common.retry')}
          </Button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    if (emptyText === undefined || emptyText === '') return null;
    return (
      <p className={cn(WRAPPER_CLASS, 'text-muted-foreground/70')} role="status">
        {emptyText}
      </p>
    );
  }

  return <>{children}</>;
}
