/**
 * @file 主题访问 hook。
 *
 * 职责：在 React 组件中读取 ThemeProviderContext 暴露的主题状态与操作，
 *   包括当前 theme（'light' | 'dark' | 'system'）、resolvedTheme（实际生效值）、
 *   setTheme 切换函数等。
 *
 * 设计要点：
 *  - 必须在 {@link ThemeProvider} 内部使用，否则抛错以提示开发者；
 *  - 通过 React Context 实现跨组件树共享，无需逐层 props 传递；
 *  - 抛错行为早于 React 19 的默认空 context，确保错误立即可见。
 *
 * @see src/lib/theme-context.ts —— Context 定义与初始状态
 * @see src/components/ThemeProvider.tsx —— Provider 实现与状态逻辑
 */

import { useContext } from 'react'
import { ThemeProviderContext } from '@/lib/theme-context'

/**
 * 获取当前主题上下文。
 *
 * 必须在 {@link ThemeProvider} 子树中调用，否则抛出错误。
 * 通过抛错（而非返回默认值）确保开发者不会忘记包裹 Provider，
 * 与 shadcn/ui 官方 useTheme 实现一致。
 *
 * @returns ThemeProviderState —— 包含 theme、resolvedTheme、setTheme 等
 * @throws Error —— 调用点未位于 ThemeProvider 内时抛出
 *
 * @example
 * const { theme, setTheme } = useTheme()
 * return (
 *   <button onClick={() => setTheme('dark')}>
 *     切换到深色
 *   </button>
 * )
 */
export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  // context === undefined 表示没有匹配的 Provider 在上层
  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider')

  return context
}
