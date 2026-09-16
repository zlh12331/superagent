// src/renderer/components/ui/tooltip.tsx
// 提示框组件（shadcn/ui new-york 风格，基于 @radix-ui/react-tooltip）
// 设计文档 §2.3 shadcn/ui 组件库

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type * as React from 'react';

/**
 * 提示框 Provider
 *
 * 必须包裹在应用根部，为 Tooltip 提供共享上下文与延迟等全局行为。
 * ──────────────────────────────
 * 注意：本文件**只**导出 Provider。仓库内目前没有任何 Tooltip/Trigger/Content
 * 组件消费它（providers/index.tsx 挂载时也未传 props，走 Radix 默认延迟）——
 * 引入 shadcn 组件集时留下的载体，保留以备后续实现内容组件。
 * ──────────────────────────────
 * 变体：无
 * 状态：非受控（悬停/聚焦触发）
 * 依赖：@radix-ui/react-tooltip
 * 可访问性：Radix 内置 focus/pointer 触发 + ARIA tooltip 语义
 * ──────────────────────────────
 */
export function TooltipProvider(
  props: React.ComponentProps<typeof TooltipPrimitive.Provider>,
): React.ReactElement {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" {...props} />;
}
