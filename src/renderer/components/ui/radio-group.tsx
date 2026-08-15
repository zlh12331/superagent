// src/renderer/components/ui/radio-group.tsx
// 单选组组件（shadcn/ui new-york 风格，基于 @radix-ui/react-radio-group）
// 设计文档 §2.3 shadcn/ui 组件库

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { CircleIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 单选组根容器
 *
 * 包装 Radix RadioGroup Primitive，管理选中值 + 方向键导航（上下/左右）。
 * 通过 value / onValueChange 受控或 defaultValue 非受控。
 * ──────────────────────────────
 * 变体：无（尺寸由 className 控制）
 * 状态：受控（value + onValueChange）| 非受控（defaultValue）
 * 依赖：@radix-ui/react-radio-group
 * 可访问性：Radix 内置 role=radiogroup/radio + 方向键导航；Item 须配 label 或 aria-label
 * ──────────────────────────────
 */
export function RadioGroup(
  props: React.ComponentProps<typeof RadioGroupPrimitive.Root>,
): React.ReactElement {
  return <RadioGroupPrimitive.Root data-slot="radio-group" {...props} />;
}

/**
 * 单选圆点
 *
 * 选中态显示实心圆点（primary 色）；键盘可达（Tab 聚焦 + 方向键切换）。
 */
export function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.ReactElement {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aspect-square size-4 shrink-0 cursor-pointer rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="relative flex items-center justify-center">
        <CircleIcon className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
