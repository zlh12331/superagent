// src/renderer/providers/index.tsx
// 应用 Provider 组合入口
// 设计文档 §3 目录结构：providers/ 组合各 Provider
// 顺序：ThemeProvider → TooltipProvider → Toaster → children
// 注意：Toaster（sonner）放在最后，确保所有 toast 能渲染在最上层

import type { ReactElement, ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import { ThemeProvider } from './ThemeProvider';

/**
 * 应用根 Provider 组合
 *
 * 嵌套顺序（外 → 内）：
 * 1. ThemeProvider：主题最外层，确保所有组件能读取主题
 * 2. TooltipProvider：UI 上下文，控制 Tooltip 全局延迟
 * 3. Toaster：sonner toast 容器，渲染在 children 旁，浮在最上层
 *
 * 在 main.tsx / App.tsx 中包裹 <AppProviders><App /></AppProviders> 即可。
 */
export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  return (
    <ThemeProvider>
      <TooltipProvider>
        {children}
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
