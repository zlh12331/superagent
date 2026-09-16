// src/renderer/components/ui/sheet.tsx
// 抽屉组件（全屏覆盖，基于 @radix-ui/react-dialog）
// ──────────────────────────────────────────────────────────────
// 用途：设置抽屉等"侧边滑出面板"场景（对齐原型 .drawer）
// - Sheet = Dialog 根（受控 open/onOpenChange）
// - SheetOverlay = 半透明遮罩（点击关闭）
// - SheetContent = inset-0 全屏覆盖面板（无开合动画，瞬时切换）
//   当前唯一使用方 SettingsDialog 是全屏设置页；尺寸由调用方 className 控制
//   （历史遗留：本组件曾为 side="right" 滑出抽屉，现已无 side prop）
// - SheetTitle / SheetDescription = 无障碍标题（可 sr-only 隐藏）
// ──────────────────────────────────────────────────────────────

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** 抽屉根容器（与 Dialog 同源，受控开关）
 * ──────────────────────────────
 * 变体：Content 为全屏覆盖（inset-0），尺寸经 className 调整
 * 状态：受控（open + onOpenChange）| 非受控（defaultOpen）
 * 依赖：@radix-ui/react-dialog
 * 可访问性：与 Dialog 一致（焦点陷阱/Escape/ARIA），需 SheetTitle/SheetDescription
 * ──────────────────────────────
 */
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
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-popover bg-overlay-bg',
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
          // 无开合动画（当前唯一使用方 SettingsDialog 为全屏设置页，瞬时切换）
          'bg-background fixed inset-0 z-popover h-full w-full shadow-lg',
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
