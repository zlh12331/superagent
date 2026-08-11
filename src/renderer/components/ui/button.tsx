// src/renderer/components/ui/button.tsx
// 按钮组件（shadcn/ui new-york 风格）
// 设计文档 §2.3 shadcn/ui 组件库

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 按钮样式变体定义
 *
 * 使用 class-variance-authority（cva）集中管理按钮的所有视觉变体：
 * - variant：控制颜色风格（default/outline/ghost 等）
 * - size：控制尺寸（default/sm/lg/icon）
 *
 * 通过 buttonVariants 函数也可单独复用样式（例如给 <a> 链接套用按钮外观）。
 * ──────────────────────────────
 * 变体：variant=default|destructive|outline|secondary|ghost|link / size=default|sm|lg|icon
 * 状态：非受控（原生 button）+ asChild 支持任意渲染元素
 * 依赖：class-variance-authority + @radix-ui/react-slot（asChild）
 * 可访问性：原生 button 语义；disabled 态含 pointer-events 与视觉降级
 * ──────────────────────────────
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * Button 组件属性
 *
 * 在原生 <button> 属性基础上扩展：
 * - variant / size：透传给 buttonVariants
 * - asChild：true 时把渲染职责交给子元素（通过 Radix Slot），常用于把 <a> 当按钮用
 */
export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * 通用按钮组件
 *
 * @example
 * <Button variant="default" size="sm">保存</Button>
 * <Button asChild><a href="/x">链接式按钮</a></Button>
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): React.ReactElement {
  // asChild 时把 props 合并到子元素（Radix Slot 机制）
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
