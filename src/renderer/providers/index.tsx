// src/renderer/providers/index.tsx
// 应用 Provider 组合入口
// 设计文档 §3 目录结构：providers/ 组合各 Provider
//
// 嵌套顺序（外 → 内）：
// 1. I18nProvider：i18n 最外层，确保所有组件能查询文案
// 2. ThemeProvider：主题次外层，确保所有组件能读取主题
// 3. QueryProvider：TanStack Query，注入 useQuery / useMutation
// 4. TooltipProvider：UI 上下文，控制 Tooltip 全局延迟
// 5. Toaster：sonner toast 容器，渲染在 children 旁，浮在最上层
//
// 顺序理由：
// - I18nProvider 最外：文案是所有 UI 的基础，theme / query / tooltip 都可能用到文案
// - ThemeProvider 次外：theme 状态需要先于 query 失败提示生效
// - QueryProvider 在内：业务组件需要 useQuery，Query 不依赖 theme
// - Toaster 放最后：确保所有 toast 能渲染在最上层

import type { ReactElement, ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import { I18nProvider } from '@/i18n';

import { QueryProvider } from './QueryProvider';
import { ThemeProvider } from './ThemeProvider';

/**
 * 应用根 Provider 组合
 *
 * 在 main.tsx / App.tsx 中包裹 <AppProviders><App /></AppProviders> 即可。
 */
export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  return (
    <I18nProvider>
      <ThemeProvider>
        <QueryProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </QueryProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
