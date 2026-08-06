// src/renderer/components/ui/sheet.tsx
// 抽屉组件（右侧滑出，基于 @radix-ui/react-dialog）
// ──────────────────────────────────────────────────────────────
// 用途：设置抽屉等"侧边滑出面板"场景（对齐原型 .drawer）
// - Sheet = Dialog 根（受控 open/onOpenChange）
// - SheetOverlay = 半透明遮罩（点击关闭）
// - SheetContent = 右侧滑出面板（slide-in-from-right 动画）
//   side="right"：宽度由调用方控制（支持拖拽调宽），高度占满视口
// - SheetTitle / SheetDescription = 无障碍标题（可 sr-only 隐藏）
// ──────────────────────────────────────────────────────────────

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** 抽屉根容器（与 Dialog 同源，受控开关） */
export function Sheet(
  props: React.ComponentProps<typeof DialogPrimitive.Root>,
): React.ReactElement {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

/** 抽屉遮罩层 */
export function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.ReactElement {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50',
        className,
      )}
      {...props}
    />
  );
}

/** 抽屉内容区 */
export function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.ReactElement {
  return (
    <DialogPrimitive.Portal data-slot="sheet-portal">
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 h-full w-full shadow-lg duration-200 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** 抽屉标题（可 sr-only 隐藏，保留无障碍语义） */
export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.ReactElement {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  );
}

/** 抽屉描述（可 sr-only 隐藏，保留无障碍语义） */
export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.ReactElement {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}
