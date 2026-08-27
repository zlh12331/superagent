// src/renderer/components/ui/select.tsx
// 下拉选择组件（shadcn/ui new-york 风格，基于 @radix-ui/react-select）
// 设计文档 §2.3 shadcn/ui 组件库

import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 选择根容器
 *
 * 包装 Radix Select Primitive，负责管理展开/值状态。
 * 通过 value / onValueChange 受控或 defaultValue 非受控。
 * ──────────────────────────────
 * 变体：Trigger 支持 size（default/sm）；Item 支持 inset
 * 状态：受控（value + onValueChange）| 非受控（defaultValue）
 * 依赖：@radix-ui/react-select
 * 可访问性：Radix 内置全键盘导航/方向键/ARIA listbox 角色；9 个导出覆盖完整下拉形态
 * ──────────────────────────────
 */
export function Select(
  props: React.ComponentProps<typeof SelectPrimitive.Root>,
): React.ReactElement {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** 选项分组容器（透传 Radix Group） */
export function SelectGroup(
  props: React.ComponentProps<typeof SelectPrimitive.Group>,
): React.ReactElement {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/** 当前值展示（placeholder 空态自动显示） */
export function SelectValue(
  props: React.ComponentProps<typeof SelectPrimitive.Value>,
): React.ReactElement {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/**
 * 下拉触发器
 *
 * 显示当前值 + 展开箭头；键盘可达（Enter/Space/方向键）。
 */
export function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  /** 尺寸：default 高 9（36px），sm 高 8（32px） */
  size?: 'default' | 'sm';
}): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 flex w-fit cursor-pointer items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-muted-foreground/60 size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** 下拉内容传送门 + 浮动面板（自带滚动/定位/焦点陷阱） */
export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>): React.ReactElement {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 relative z-popover max-h-(--radix-select-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** 单个选项（选中态 Check 标记；键盘方向键导航） */
export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>): React.ReactElement {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
      {...props}
    />
  );
}

/** 单个选项（选中态 Check 标记；键盘方向键导航） */
export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>): React.ReactElement {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** 选项分隔线 */
export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>): React.ReactElement {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

/** 列表向上滚动按钮（选项超长自动出现） */
export function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>): React.ReactElement {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        'text-muted-foreground flex cursor-default items-center justify-center py-1',
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

/** 列表向下滚动按钮（选项超长自动出现） */
export function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>): React.ReactElement {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        'text-muted-foreground flex cursor-default items-center justify-center py-1',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}
