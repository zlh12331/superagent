// src/renderer/components/ui/skeleton.tsx
// 骨架屏组件（shadcn/ui new-york 风格）
// 设计文档 §2.3 shadcn/ui 组件库

import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 骨架屏占位组件
 *
 * 用于在数据加载完成前展示一个灰色的占位块，模拟内容形状。
 * 通过 Tailwind 的 animate-pulse 提供呼吸动画。
 *
 * @example
 * <Skeleton className="h-4 w-32" />
 * <Skeleton className="size-12 rounded-full" />
 * ──────────────────────────────
 * 变体：无（尺寸/形状完全由 className 决定）
 * 状态：无状态（纯展示）
 * 依赖：无
 * 可访问性：装饰性元素。视具体用法二选一——内容区整体加载时在外层容器给
 *   role="status"/aria-busy（骨架块本身不播报）；或给本组件传 aria-hidden
 *   （props 直接透传到根 div，可用）
 * ──────────────────────────────
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-accent animate-pulse rounded-md', className)}
      {...props}
    />
  );
}
