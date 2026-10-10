import { Loader2 } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** Spinner props：透传 Loader2 图标 props，label 覆盖读屏文案，aria-hidden 降级为装饰 */
export interface SpinnerProps extends React.ComponentProps<typeof Loader2> {
  /** 屏幕阅读器文案（默认 i18n "加载中"；父容器已有加载语义时无需关闭） */
  readonly label?: string;
}

/** 加载指示器：外层 role="status" + sr-only 文案，aria-hidden 可整体降级为装饰（见文件头注释） */
export function Spinner({ className, label, ...props }: SpinnerProps): React.ReactElement {
  const { t } = useTranslation();
  const decorative = props['aria-hidden'] === true || props['aria-hidden'] === 'true';
  const { 'aria-hidden': _ariaHidden, ...iconProps } = props;
  return (
    <span
      className="inline-flex"
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'status'}
    >
      {!decorative && <span className="sr-only">{label ?? t('common.loading')}</span>}
      <Loader2
        aria-hidden
        className={cn('size-3.5 animate-spin text-current', className)}
        {...iconProps}
      />
    </span>
  );
}
