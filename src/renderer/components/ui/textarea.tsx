// src/renderer/components/ui/textarea.tsx
// 文本域组件（shadcn/ui new-york 风格）
// 设计文档 §2.3 shadcn/ui 组件库

import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 基础多行文本输入框
 *
 * 直接包裹原生 <textarea>，套用与 Input 一致的边框、圆角与 focus 环样式，
 * 让表单中的两类输入控件视觉统一。
 *
 * @example
 * <Textarea placeholder="请输入正文……" rows={6} />
 * ──────────────────────────────
 * 变体：无（与 Input 同视觉体系）
 * 状态：非受控（原生 textarea，value/defaultValue 均可）
 * 依赖：无（原生 <textarea> 包装）
 * 可访问性：原生 textarea 语义 + aria-invalid 错误态样式
 * ──────────────────────────────
 */
export function Textarea({
  className,
  ...props
}: React.ComponentProps<'textarea'>): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-sm transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
