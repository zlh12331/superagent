/**
 * ThemeProvider —— 全局主题上下文 Provider。
 *
 * 职责：
 *  - 读取 localStorage 中持久化的主题（fallback 到 defaultTheme）
 *  - 监听 usePreferences 返回的远程偏好，首次同步覆盖本地主题
 *  - 通过 setTheme 统一入口更新主题：写 localStorage + 更新 React state + 跨窗口 emit
 *  - 在 useLayoutEffect 中应用主题 class，避免 FOUC（Flash of Unstyled Content）
 *  - system 主题时监听 prefers-color-scheme 变化，自动切换 dark/light
 *
 * 架构位置：位于 App 根，包裹所有业务组件，通过 ThemeProviderContext 暴露 theme / setTheme。
 */

import { useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react'
import { emit } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/env'
import { ThemeProviderContext, type Theme } from '@/lib/theme-context'
import { usePreferences } from '@/queries/preferences'
import {
  applyThemeClass,
  isValidTheme,
  readStoredTheme,
  writeStoredTheme,
} from '@/lib/theme'

interface ThemeProviderProps {
  /** 需要消费主题上下文的子树 */
  children: React.ReactNode
  /** 默认主题（localStorage 无记录时使用），默认 'dark' */
  defaultTheme?: Theme
}

/**
 * ThemeProvider 组件 —— 提供 theme / setTheme 给子树。
 *
 * 渲染逻辑：
 *  - 通过 ThemeProviderContext.Provider 将 { theme, setTheme } 注入子树
 *  - 其余未消费的 props 透传给 Provider（便于扩展）
 *
 * 状态依赖：
 *  - 本地 useState<Theme> 管理 theme，初始值来自 readStoredTheme(defaultTheme)
 *  - 通过 usePreferences() 监听远程偏好（preferences.json），首次同步覆盖本地
 *  - hasSyncedPreferences ref 确保偏好仅同步一次，避免循环覆盖
 *
 * 副作用：
 *  - useLayoutEffect（同步偏好）：preferences.theme 首次加载且合法时，queueMicrotask 调用 setTheme
 *  - useLayoutEffect（应用主题）：applyThemeClass(theme)；system 主题时注册 matchMedia 监听
 *
 * 设计决策：
 *  - 使用 useLayoutEffect 而非 useEffect：在浏览器绘制前应用主题，避免 FOUC
 *  - queueMicrotask 推迟 setState：避免「setState in effect」lint 错误
 *  - 跨窗口同步：emit('theme-changed') 让其他窗口（如 QuickPane）同步主题
 *
 * @param props —— 见 ThemeProviderProps 接口
 */
export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    readStoredTheme(defaultTheme)
  )

  // 跟踪系统配色偏好（prefers-color-scheme: dark）。
  // 仅在 theme === 'system' 时决定 resolvedTheme；通过 matchMedia 事件异步更新，
  // 不在 effect 体内同步 setState（符合 react-hooks/set-state-in-effect 规则）。
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  // 实际生效的主题：'system' 解析为 light/dark，其余即 theme 本身。
  // 采用派生计算而非独立 state —— 遵循 React「不要同步派生状态」最佳实践，
  // theme 或 systemPrefersDark 变化时自动重算，始终与 applyThemeClass 应用的结果一致。
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme

  // 从持久化偏好中加载主题
  const { data: preferences } = usePreferences()
  const hasSyncedPreferences = useRef(false)

  /**
   * 统一的主题设置器 — 更新 React 状态、持久化到 localStorage，
   * 并通知其他窗口。这是主题变更的唯一入口；所有调用方
   * （偏好同步、UI 交互等）都必须通过此函数，以确保各存储保持同步。
   */
  const setTheme = useCallback((newTheme: Theme) => {
    writeStoredTheme(newTheme)
    setThemeState(newTheme)
    // 仅在 Tauri 环境下 emit 跨窗口事件（浏览器模式下 emit 会抛异常）。
    // isTauri() 依据 window.__TAURI_INTERNALS__ 判定，纯浏览器开发态返回 false。
    if (isTauri()) {
      void emit('theme-changed', { theme: newTheme })
    }
  }, [])

  // 偏好加载后同步主题（仅执行一次）。
  // 使用统一的 setTheme 以同步更新 localStorage 和跨窗口事件，
  // 避免 localStorage 与 preferences.json 之间出现不一致。
  //
  // 将 setState 推迟到微任务中执行，以避免
  // "setState in effect" lint 错误 — 这是外部系统同步
  // （preferences.json → React 状态），而非派生状态计算。
  useLayoutEffect(() => {
    if (preferences?.theme && !hasSyncedPreferences.current) {
      hasSyncedPreferences.current = true

      if (isValidTheme(preferences.theme)) {
        // 推迟到微任务执行，避免级联渲染
        queueMicrotask(() => setTheme(preferences.theme as Theme))
      }
    }
  }, [preferences?.theme, setTheme])

  // 将主题 class 应用到 DOM — useLayoutEffect 在浏览器绘制之前运行，
  // 避免出现错误主题的闪烁（FOUC）。
  useLayoutEffect(() => {
    // 解析当前实际生效的主题（system → matchMedia 结果，其余 → theme 本身）
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    applyThemeClass(resolved)

    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      applyThemeClass(e.matches ? 'dark' : 'light')
      // 异步事件回调中更新 state，不违反 set-state-in-effect 规则。
      // systemPrefersDark 变化后 resolvedTheme 自动重算并同步到 context。
      setSystemPrefersDark(e.matches)
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  // useMemo 包裹 value 对象，避免 Provider 因父组件重渲染时创建新引用，
  // 导致所有消费 useTheme() 的子组件不必要重渲染（theme/resolvedTheme/setTheme 未变时引用稳定）
  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
