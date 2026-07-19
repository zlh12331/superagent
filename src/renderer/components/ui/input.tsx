// src/renderer/components/ui/input.tsx
// 输入框组件（shadcn/ui new-york 风格）
// 设计文档 §2.3 shadcn/ui 组件库

import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 基础单行文本输入框
 *
 * 直接包裹原生 <input>，套用项目主题（边框、圆角、focus 环）。
 * 通过 data-slot 标识便于父组件做样式穿透或测试选择器。
 *
 * @example
 * <Input type="email" placeholder="you@example.com" />
 */
export function Input({
  className,
  type,
  ...props
}: React.ComponentProps<'input'>): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-sm transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
