// src/renderer/components/ui/alert.tsx
// 警示横幅组件（shadcn/ui new-york 风格，基于 div + role="alert"）
// 设计文档 §2.3 shadcn/ui 组件库

import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        // 此前带 *:data-[slot=alert-description]:text-error-text/90——本文件不导出
        // AlertDescription，全仓也无该 slot，选择器永远匹配不到（已移除）
        destructive: 'text-error-text bg-card [&>svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * 警示横幅根容器
 *
 * role="alert" 语义（屏幕阅读器即时播报）。图标作为首个子元素时自动排左列。
 * ──────────────────────────────
 * 变体：default（卡片风）/ destructive（错误风）
 * 状态：无（纯展示；需要附加操作时由业务层在 AlertTitle 内自行放置按钮）
 * 依赖：无（div + cva）
 * 可访问性：role="alert" 即时播报
 * ──────────────────────────────
 */
export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>): React.ReactElement {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

/** 警示标题（单行粗体） */
export function AlertTitle({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  );
}

export { alertVariants };
