// src/renderer/components/ui/card.tsx
// 卡片组件（shadcn/ui new-york 风格）
// 设计文档 §2.3 shadcn/ui 组件库

import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 卡片容器
 *
 * 用于把一组相关内容包裹成一个视觉上独立的面板。
 * new-york 风格使用 rounded-xl（比默认 rounded-lg 更圆），
 * 内部使用 flex 纵向布局并通过 gap 控制子组件间距。
 *
 * @example
 * <Card>
 *   <CardHeader>...</CardHeader>
 *   <CardContent>...</CardContent>
 *   <CardFooter>...</CardFooter>
 * </Card>
 */
export function Card({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card"
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 卡片头部区域
 *
 * 通常包含标题、描述与可选的操作按钮。
 * 内部使用 grid 布局以便 CardAction 通过 col-start-2 占据右侧。
 */
export function CardHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 卡片标题
 *
 * 字体加粗，与 CardDescription 区分。
 */
export function CardTitle({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

/**
 * 卡片描述
 *
 * 用于在标题下方给出一段次要说明，颜色更浅。
 */
export function CardDescription({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

/**
 * 卡片操作区
 *
 * 通常放在 CardHeader 的右侧，用于放置次要按钮/图标按钮。
 * 通过 col-start-2 自动落到 grid 第二列。
 */
export function CardAction({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

/**
 * 卡片主体内容
 *
 * 承载主要信息，左右各保留 px-6 内边距。
 */
export function CardContent({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />;
}

/**
 * 卡片底部
 *
 * 常用于放置主操作按钮（如「保存」「取消」），
 * 使用 flex + justify-end 默认右对齐。
 */
export function CardFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  );
}
