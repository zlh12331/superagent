// src/renderer/components/ui/context-menu.tsx
// 右键菜单组件（shadcn/ui new-york 风格，基于 @radix-ui/react-context-menu）
// 设计文档 §2.3 shadcn/ui 组件库

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 右键菜单根容器
 *
 * 包装 Radix ContextMenu Primitive，管理打开状态。
 * Trigger 包裹目标元素，右键触发；Portal 渲染到 body（不受父级 transform 影响）。
 * ──────────────────────────────
 * 变体：Item 支持 inset（缩进）与 variant="destructive"（危险操作红字）
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
