// src/renderer/components/ui/badge.tsx
// 徽章组件（shadcn/ui new-york 风格，零依赖 span + cva 变体）
// 设计文档 §2.3 shadcn/ui 组件库

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90 border-transparent',
        secondary:
          'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90 border-transparent',
        destructive:
          'bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 border-transparent',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * 徽章组件
 *
 * 小标签/计数/状态标记。asChild 支持套 <a> 链接。
 * ──────────────────────────────
 * 变体：default / secondary / destructive / outline
 * 状态：无（纯展示）
 * 依赖：无（span + cva）
 * 可访问性：纯文本展示，无交互语义
 * ──────────────────────────────
 */
export function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }): React.ReactElement {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
