// src/renderer/components/ui/context-menu.tsx
// 右键菜单组件（shadcn/ui new-york 风格，基于 @radix-ui/react-context-menu）
// 设计文档 §2.3 shadcn/ui 组件库

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 右键菜单根容器
 *
 * 包装 Radix ContextMenu Primitive，管理打开状态。
 * Trigger 包裹目标元素，右键触发；Portal 渲染到 body（不受父级 transform 影响）。
 * ──────────────────────────────
 * 变体：Item 支持 inset；Shortcut 键位提示；CheckboxItem/RadioItem 选中语义
 * 状态：受控（open + onOpenChange）| 非受控（defaultOpen）
 * 依赖：@radix-ui/react-context-menu
 * 可访问性：Radix 内置 focus trap / 方向键导航 / Esc / aria-haspopup=menu
 * ──────────────────────────────
 */
export function ContextMenu(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Root>,
): React.ReactElement {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

/** 右键触发目标（asChild 包裹现有元素） */
export function ContextMenuTrigger(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>,
): React.ReactElement {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

/** 菜单分组容器 */
export function ContextMenuGroup(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Group>,
): React.ReactElement {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

/** 传送门（渲染到 body 末尾，规避父级 overflow/transform） */
export function ContextMenuPortal(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Portal>,
): React.ReactElement {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

/** 子菜单根（Item 的 sub 属性触发） */
export function ContextMenuSub(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>,
): React.ReactElement {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

/** 单选组（RadioItem 容器） */
export function ContextMenuRadioGroup(
  props: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>,
): React.ReactElement {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

/** 子菜单触发器 */
export function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  /** 缩进（嵌套子菜单层级用） */
  inset?: boolean;
}): React.ReactElement {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

/** 子菜单内容（Sub 的弹出面板） */
export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>): React.ReactElement {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-popover min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg',
        className,
      )}
      {...props}
    />
  );
}

/** 菜单主体内容（浮动面板，focus trap 内置） */
export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>): React.ReactElement {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-popover min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-md',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

/** 菜单项（键盘方向键导航；选中态 accent） */
export function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  /** 缩进（嵌套子菜单层级用） */
  inset?: boolean;
  /** 危险操作（删除等，红色系） */
  variant?: 'default' | 'destructive';
}): React.ReactElement {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-error-text data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-error-text relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/** 复选项（选中打勾） */
export function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>): React.ReactElement {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...(checked !== undefined ? { checked } : {})}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

/** 单选项（组内选中打点） */
export function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>): React.ReactElement {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

/** 分组标签 */
export function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
}): React.ReactElement {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn('text-foreground px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className)}
      {...props}
    />
  );
}

/** 分隔线 */
export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>): React.ReactElement {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

/** 快捷键提示（右对齐 mono 小字） */
export function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  );
}
