// src/renderer/components/ui/tooltip.tsx
// 提示框组件（shadcn/ui new-york 风格，基于 @radix-ui/react-tooltip）
// 设计文档 §2.3 shadcn/ui 组件库

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 提示框 Provider
 *
 * 必须包裹在应用根部，控制 Tooltip 的延迟等全局行为。
 */
export function TooltipProvider(
  props: React.ComponentProps<typeof TooltipPrimitive.Provider>,
): React.ReactElement {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" {...props} />;
}

/**
 * 提示框根容器
 *
 * 每个 Tooltip 实例需要一个 Root，内部包裹 Trigger 与 Content。
 */
export function Tooltip(
  props: React.ComponentProps<typeof TooltipPrimitive.Root>,
): React.ReactElement {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/**
 * 提示框触发器
 *
 * 通常包裹一个图标按钮，hover/focus 时显示 TooltipContent。
 */
export function TooltipTrigger(
  props: React.ComponentProps<typeof TooltipPrimitive.Trigger>,
): React.ReactElement {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * 提示框内容
 *
 * 显示在触发器旁的小气泡，文本简短。
 * 默认带淡入淡出与缩放动画，z-index 50 浮在最上层。
 */
export function TooltipContent({
  className,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        className={cn(
          'bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
