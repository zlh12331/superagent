// src/renderer/providers/ThemeProvider.tsx
// 暗黑模式主题 Provider（next-themes）
// 设计文档 §2.3：shadcn/ui + Tailwind v4 暗黑模式
// - next-themes 通过给 <html> 添加 .dark class 切换主题
// - 与 globals.css 中的 :root / .dark 变量对齐
// - attribute="class"：使用 class 策略而非 data-theme
// - defaultTheme="system"：跟随系统偏好
// - enableSystem：启用 system 主题
// - disableTransitionOnChange：切换时禁用过渡动画，避免闪烁

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactElement, ReactNode } from 'react';

/**
 * 暗黑模式主题 Provider
 *
 * 包装 next-themes 的 ThemeProvider，统一项目主题策略：
 * - attribute="class"：通过 .dark class 切换，与 Tailwind v4 dark: 变量对齐
 * - defaultTheme="system" + enableSystem：默认跟随操作系统偏好
 * - disableTransitionOnChange：切换主题时禁用过渡，避免颜色闪烁
 *
 * 必须放在应用最外层，确保所有子组件能读取到主题状态。
 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
