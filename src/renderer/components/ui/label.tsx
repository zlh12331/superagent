// src/renderer/components/ui/label.tsx
// 标签组件（shadcn/ui new-york 风格，基于 @radix-ui/react-label）
// 设计文档 §2.3 shadcn/ui 组件库

import * as LabelPrimitive from '@radix-ui/react-label';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 表单标签组件
 *
 * 包装 Radix Label Primitive，自动处理 htmlFor 关联、无障碍点击聚焦等行为。
 * 视觉上使用项目 muted-foreground 颜色，与表单控件保持协调。
 *
 * @example
 * <Label htmlFor="email">邮箱</Label>
 * ──────────────────────────────
 * 变体：无
 * 状态：非受控（关联原生控件）
 * 依赖：@radix-ui/react-label
 * 可访问性：htmlFor 关联 + 点击聚焦（Radix 内置）
 * ──────────────────────────────
 */
export function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>): React.ReactElement {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
