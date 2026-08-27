// src/renderer/components/ui/dialog.tsx
// 对话框组件（shadcn/ui new-york 风格，基于 @radix-ui/react-dialog）
// 设计文档 §2.3 shadcn/ui 组件库

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/**
 * 对话框根容器
 *
 * 包装 Radix Dialog Primitive，负责管理开关状态。
 * 可通过 open / onOpenChange 受控，或 defaultOpen 非受控。
 * ──────────────────────────────
 * 变体：Content 支持 showCloseButton（默认 true）/ className 控制尺寸
 * 状态：受控（open + onOpenChange）| 非受控（defaultOpen）
 * 依赖：@radix-ui/react-dialog
 * 可访问性：Radix 内置焦点陷阱/Escape 关闭/ARIA dialog 角色；需 SheetTitle 提供标题
 * ──────────────────────────────
 */
export function Dialog(
  props: React.ComponentProps<typeof DialogPrimitive.Root>,
): React.ReactElement {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/**
 * 对话框触发器
 *
 * 通常包裹一个按钮，点击后打开对话框。
 * 通过 asChild 把事件合并到子元素。
 */
export function DialogTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>,
): React.ReactElement {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/**
 * 对话框传送门
 *
 * 把内容渲染到 body 末尾，避免被父级 overflow / transform 影响。
 */
export function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
): React.ReactElement {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/**
 * 对话框关闭按钮
 *
 * 可放在 Header/Footer 中作为「取消」按钮使用。
 */
export function DialogClose(
  props: React.ComponentProps<typeof DialogPrimitive.Close>,
): React.ReactElement {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * 对话框遮罩层
 *
 * 覆盖整个视口，半透明背景用于聚焦对话框内容并阻止点击外部区域。
 */
export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.ReactElement {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-popover bg-[var(--overlay-bg)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 对话框主体内容
 *
 * 包含真正的对话框面板：标题、描述、内容、底部按钮等。
 * 自带 Esc 关闭、点击遮罩关闭、焦点陷阱等无障碍行为。
 * 默认右上角自动渲染关闭按钮（X 图标），可通过 showCloseButton 关闭。
 */
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** 是否渲染右上角关闭按钮（默认 true；对齐参考项目 showCloseButton prop） */
  showCloseButton?: boolean;
}): React.ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-popover grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        {children}
        {/* 对齐参考项目：showCloseButton=false 时隐藏右上角关闭按钮（如搜索对话框） */}
        {showCloseButton && (
          <DialogPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
            <XIcon />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * 对话框头部
 *
 * 包裹标题与描述，统一布局间距。
 */
export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  );
}

/**
 * 对话框底部
 *
 * 通常放置「取消」「确认」按钮，右对齐排列。
 */
export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

/**
 * 对话框标题
 *
 * 视觉上加粗；语义上提供给屏幕阅读器使用。
 */
export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.ReactElement {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  );
}

/**
 * 对话框描述
 *
 * 标题下方的辅助说明文字，颜色更浅。
 */
export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.ReactElement {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}
