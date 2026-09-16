// src/renderer/components/ui/toggle-group.tsx
// 切换组组件（shadcn/ui 风格，基于 @radix-ui/react-toggle-group）
// ──────────────────────────────────────────────
// 用途：互斥/多选切换控件组（对齐 Radix ToggleGroup 语义）。
// - 容器 ToggleGroup：type="single"（互斥，value+onValueChange）或
//   type="multiple"（value: string[] + onValueChange: string[]）
// - 项 ToggleGroupItem：value 必填，激活态由 Radix data-state=on 驱动
//
// 背景（2026-09 一致性收敛）：此前 SegControl / LogsPanel 过滤钮是手写
// aria-pressed 切换组，无方向键/roving tabindex/唯一容器语义；经用户拍板
// 引入 Radix ToggleGroup 统一（InspectorPanel 的触发钮最终未迁移，仍是 Button）
//
// 变体：默认（紧凑行内）
// 状态：容器受控（single: value+onValueChange | multiple: value[]+onValueChange）
// 依赖：@radix-ui/react-toggle-group
// 可访问性：Radix 内置方向键切换/RoamingTabIndex/ARIA toggle 语义
// ──────────────────────────────────────────────

import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/** 切换组根容器（type 必填——Radix 不会从 value/onValueChange 推导；single 用受控 value） */
export function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>): React.ReactElement {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex items-center gap-1', className)}
      {...props}
    />
  );
}

/** 切换组项（激活态由 Radix data-state=on 驱动；激活样式走语义令牌 bg-accent） */
export function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>): React.ReactElement {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:ring-ring flex-1 cursor-pointer rounded-md border border-transparent px-2.5 py-1 font-mono text-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none',
        'data-[state=on]:bg-accent data-[state=on]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
