// src/renderer/components/ui/spinner.tsx
// 环形加载指示器（统一原语：替代散落的手写 CSS 圆环）
// ──────────────────────────────
// 变体：无（尺寸/颜色经 className 与 currentColor 控制）
// 状态：纯展示
// 依赖：lucide-react Loader2（Icon 组件，随字体栈渲染，无独立 CSS 动画依赖）
// 用法：
//   <Spinner className="size-6" />
// 可访问性：role="status" + sr-only "Loading"，屏幕阅读器播报加载语义；
//   容器若已有 role="status"/aria-busy 父级，可传 aria-hidden 降级为装饰
// ──────────────────────────────

import { Loader2 } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

export interface SpinnerProps extends React.ComponentProps<typeof Loader2> {
  /** 屏幕阅读器文案（默认 i18n "加载中"；父容器已有加载语义时无需关闭） */
  readonly label?: string;
}

export function Spinner({ className, label, ...props }: SpinnerProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="inline-flex" role="status">
      <span className="sr-only">{label ?? t('common.loading')}</span>
      <Loader2
        aria-hidden
        className={cn('size-3.5 animate-spin text-current', className)}
        {...props}
      />
    </span>
  );
}
