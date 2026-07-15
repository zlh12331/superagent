/**
 * @file 主题上下文定义模块（与 React 解耦的类型与 Context 容器）。
 *
 * 设计意图：
 *  - 将 Theme 类型与 Provider State 接口独立成文件，便于被 lib/theme.ts
 *    （纯函数工具）和 components/ThemeProvider.tsx（具体实现）共享；
 *  - 避免循环依赖：theme.ts 不能 import ThemeProvider.tsx（后者依赖前者），
 *    因此把"类型与 Context"抽出到本文件作为中间层。
 *
 * 消费方：
 *  - hooks/use-theme.ts：useContext 消费此 Context；
 *  - components/ThemeProvider.tsx：作为 Provider value 提供具体实现。
 */

import { createContext } from 'react'

/**
 * 应用支持的主题值字面量联合。
 * - 'dark'   强制深色
 * - 'light'  强制浅色
 * - 'system' 跟随操作系统 prefers-color-scheme
 */
export type Theme = 'dark' | 'light' | 'system'

/**
 * ThemeProvider 暴露给消费方的状态接口。
 *
 * 字段说明：
 *  - theme       当前主题值（未经 'system' 解析）
 *  - setTheme    切换主题，实现负责持久化与 DOM 副作用
 */
export interface ThemeProviderState {
  theme: Theme
  /**
   * 实际生效的主题（'system' 已解析为 'light' | 'dark'）。
   *
   * Provider 始终提供具体值；接口标记为可选以兼容无 Provider 的默认状态
   * 与测试桩（MockThemeProvider 等）省略该字段的场景。
   */
  resolvedTheme?: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

/**
 * Provider 未挂载时的初始状态。
 *
 * setTheme 为 no-op，避免在 Provider 之外调用时抛错；
 * 真实场景下应由 hooks/use-theme.ts 中的 useContext 检测到默认实现并告警。
 */
const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
}

/**
 * 主题 Context 实例，供 ThemeProvider 注入、useTheme 消费。
 */
export const ThemeProviderContext =
  createContext<ThemeProviderState>(initialState)
