// src/renderer/components/ui/tabs.tsx
// 标签页组件（shadcn/ui new-york 风格，基于 @radix-ui/react-tabs）
// 设计文档 §2.3 shadcn/ui 组件库

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 标签页根容器
 *
 * 包装 Radix Tabs Primitive，负责管理当前激活的 Tab 值
 * （通过 value / defaultValue 受控或非受控）。
 *
 * @example
 * <Tabs defaultValue="account">
 *   <TabsList>
 *     <TabsTrigger value="account">账号</TabsTrigger>
 *     <TabsTrigger value="profile">资料</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="account">...</TabsContent>
 *   <TabsContent value="profile">...</TabsContent>
 * </Tabs>
 */
export function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>): React.ReactElement {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

/**
 * 标签页触发按钮组容器
 *
 * 横向排列 TabsTrigger，使用 bg-muted 作为底色让激活态对比更清晰。
 */
export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.ReactElement {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 单个标签页触发按钮
 *
 * 激活时通过 data-[state=active] 变成高亮卡片样式。
 */
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 标签页内容面板
 *
 * 只有当对应 value 被激活时才会渲染。
 */
export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.ReactElement {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}
