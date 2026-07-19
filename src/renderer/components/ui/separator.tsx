// src/renderer/components/ui/separator.tsx
// 分隔线组件（shadcn/ui new-york 风格，基于 @radix-ui/react-separator）
// 设计文档 §2.3 shadcn/ui 组件库

import * as SeparatorPrimitive from '@radix-ui/react-separator';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 分隔线组件
 *
 * 在视觉上把内容分成若干区域，支持水平/垂直两种方向。
 * 包装 Radix Separator Primitive 以获得 aria-orientation 等无障碍属性。
 *
 * @example
 * <Separator />                          // 水平分隔线
 * <Separator orientation="vertical" />   // 垂直分隔线
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>): React.ReactElement {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}
