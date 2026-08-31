// src/renderer/components/ui/alert-dialog.tsx
// 警告对话框组件（shadcn/ui new-york 风格，基于 @radix-ui/react-alert-dialog）
// ──────────────────────────────────────────────────────────────
// 照搬自参考项目（F:\TraeProjects\Agent2\1\src\components\ui\alert-dialog.tsx）
// 与普通 Dialog 的区别：AlertDialog 点击遮罩不会关闭，强制用户显式选择确认或取消。
// 用途：命令式 confirm/prompt 对话框（DialogHost）、删除确认等不可逆操作。
// ──────────────────────────────────────────────────────────────

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type * as React from 'react';

import { cn } from '@/lib/utils';

import { buttonVariants } from './button';

/** 对话框根容器（open/onOpenChange 受控或 defaultOpen）
 * ──────────────────────────────
 * 变体：无（遮罩不可点击关闭，强制显式确认/取消）
 * 状态：受控（open + onOpenChange）| 非受控（defaultOpen）
 * 依赖：@radix-ui/react-alert-dialog
 * 可访问性：Radix 内置焦点陷阱/ARIA alertdialog 角色；用途为不可逆操作确认
 * ──────────────────────────────
 */
export function AlertDialog(
  props: React.ComponentProps<typeof AlertDialogPrimitive.Root>,
): React.ReactElement {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

/** 传送门（渲染到 body 末尾） */
export function AlertDialogPortal(
  props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>,
): React.ReactElement {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

/** 遮罩层（点击不关闭，强制显式选择） */
export function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-popover bg-[var(--overlay-bg)]',
        className,
      )}
      {...props}
    />
  );
}

/** 对话框主体内容 */
export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>): React.ReactElement {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-popover grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

/** 头部容器 */
export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  );
}

/** 底部按钮容器 */
export function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

/** 标题 */
export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-lg font-semibold', className)}
      {...props}
    />
  );
}

/** 描述 */
export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

/** 确认按钮（默认按钮样式） */
export function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>): React.ReactElement {
  return <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />;
}

/** 取消按钮（outline 样式） */
export function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  );
}
