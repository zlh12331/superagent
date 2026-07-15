/**
 * @file 主题切换的纯 DOM/localStorage 操作工具。
 *
 * 架构位置：lib/ 中的最底层主题工具，不依赖 React；
 *   React 侧的状态管理位于 `lib/theme-context.tsx`，它通过本模块
 *   完成副作用；hooks/use-theme.ts 则对外暴露 React Hook。
 *
 * 设计原则：
 *  - 纯函数 + 直接 DOM 操作，便于在 inline 脚本、Tauri 启动脚本中复用；
 *  - 'system' 主题在此处只解析一次当前偏好，不订阅变化；
 *    需要响应式更新的调用方应自行监听 `prefers-color-scheme`。
 */

import type { Theme } from '@/lib/theme-context'

/** localStorage 中持久化主题所使用的 key 名。 */
export const THEME_STORAGE_KEY = 'ui-theme'

/**
 * 将主题值（'light' | 'dark' | 'system'）应用到 <html> 根元素。
 *
 * 这是一个纯 DOM 操作，无 React 依赖，可在 inline 脚本、事件监听器或
 * React 树外的任何位置安全调用。
 *
 * 当传入 'system' 时，根据当前 `prefers-color-scheme` 解析为 'light' 或 'dark'。
 * 本函数不会为 'system' 设置 media query 监听器 —— 需要响应系统主题变化的
 * 调用方应自行订阅 `matchMedia('(prefers-color-scheme: dark)')`。
 *
 * @param theme 待应用的主题值
 */
export function applyThemeClass(theme: Theme): void {
  const root = window.document.documentElement

  // 'system' 主题需要解析为具体的 light/dark 才能写入 class
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme

  // 先移除两个主题 class 再添加新值，避免重复 class 残留
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
}

/**
 * 类型守卫：校验任意值是否为合法的 Theme 字面量。
 *
 * 主要用于解析 localStorage 或 URL 参数等不可信来源时收窄类型，
 *   避免 `as Theme` 强制断言导致运行时脏数据进入状态机。
 *
 * @param value 任意输入
 * @returns true 表示 value 是 'light' | 'dark' | 'system' 之一
 */
export function isValidTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * 从 localStorage 读取已保存的主题，若不存在或无效则返回默认值。
 *
 * @param defaultTheme 默认主题，默认 'system' 以尊重操作系统偏好
 * @returns 已校验的 Theme 值
 */
export function readStoredTheme(defaultTheme: Theme = 'system'): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return isValidTheme(stored) ? stored : defaultTheme
}

/**
 * 将主题写入 localStorage。
 *
 * 设计说明：不在此处调用 applyThemeClass，让调用方明确控制副作用顺序，
 *   便于在测试或 SSR 场景下单独验证持久化逻辑。
 *
 * @param theme 待持久化的主题值
 */
export function writeStoredTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme)
}
