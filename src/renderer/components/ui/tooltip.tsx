// src/renderer/components/ui/tooltip.tsx
// 提示框组件（shadcn/ui new-york 风格，基于 @radix-ui/react-tooltip）
// 设计文档 §2.3 shadcn/ui 组件库

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type * as React from 'react';

/**
 * 提示框 Provider
 *
 * 必须包裹在应用根部，控制 Tooltip 的延迟等全局行为。
 * ──────────────────────────────
 * 变体：无（延迟全局配置于 AppProviders：delayDuration 默认）
 * 状态：非受控（悬停/聚焦触发）
 * 依赖：@radix-ui/react-tooltip
 * 可访问性：Radix 内置 focus/pointer 触发 + ARIA tooltip；内容可含键盘导航元素时用 TooltipContent 组合
 * ──────────────────────────────
 */
export function TooltipProvider(
  props: React.ComponentProps<typeof TooltipPrimitive.Provider>,
): React.ReactElement {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" {...props} />;
}
