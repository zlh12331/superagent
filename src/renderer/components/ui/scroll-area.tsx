// src/renderer/components/ui/scroll-area.tsx
// 滚动区域组件（shadcn/ui new-york 风格，基于 @radix-ui/react-scroll-area）
// 设计文档 §2.3 shadcn/ui 组件库

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 自定义滚动区域
 *
 * 包装 Radix ScrollArea Primitive，提供带自定义样式的滚动条
 * （比浏览器默认滚动条更细、更优雅），常用于侧边栏、列表等有限高度区域。
 *
 * @example
 * <ScrollArea className="h-72">
 *   <ul>...</ul>
 * </ScrollArea>
 */
export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

/**
 * 滚动条
 *
 * 默认为垂直方向；通过 orientation="horizontal" 可作水平滚动条，
 * 也可同时渲染两个（一竖一横）以同时支持两个方向的滚动。
 */
export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>): React.ReactElement {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
