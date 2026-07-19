// src/renderer/components/ui/sonner.tsx
// Toast 通知组件（sonner + next-themes 主题联动）
// 设计文档 §2.3 shadcn/ui 组件库 + §7.10 用户友好错误提示

import { useTheme } from 'next-themes';
import type * as React from 'react';
import { Toaster as Sonner } from 'sonner';

/**
 * 全局 Toast 容器
 *
 * 包装 sonner 的 Toaster：
 * - 通过 next-themes 的 useTheme 读取当前主题并联动 toast 配色
 * - 通过 CSS 变量（--popover / --popover-foreground / --border）让 toast 与应用主题保持一致
 *
 * 在应用根节点渲染一次即可，配合 `toast()` 函数随处调用。
 *
 * @example
 * <Toaster />                       // 在 App 根节点
 * toast.success('保存成功')         // 任意位置调用
 */
export function Toaster({ ...props }: React.ComponentProps<typeof Sonner>): React.ReactElement {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as 'system' | 'light' | 'dark'}
      className="toaster group"
      style={
        {
          // 让 toast 使用项目主题的 popover 颜色变量
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
