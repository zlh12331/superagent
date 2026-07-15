import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { useTheme } from './use-theme'
import {
  ThemeProviderContext,
  type ThemeProviderState,
} from '@/lib/theme-context'

/**
 * 构建一个提供 ThemeProviderContext 值的 wrapper 组件。
 * 使用 createElement 而非 JSX，以便文件可以保留 `.ts` 扩展名。
 */
function makeWrapper(value: ThemeProviderState) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(ThemeProviderContext.Provider, { value }, children)
  }
}

describe('useTheme', () => {
  describe('正向用例 — 在 ThemeProvider 内使用', () => {
    it('returns the context value provided by the ThemeProvider', () => {
      const value: ThemeProviderState = {
        theme: 'dark',
        setTheme: vi.fn(),
      }

      const { result } = renderHook(() => useTheme(), {
        wrapper: makeWrapper(value),
      })
      expect(result.current).toBe(value)
      expect(result.current.theme).toBe('dark')
      expect(typeof result.current.setTheme).toBe('function')
    })

    it('returns the light theme when provided', () => {
      const value: ThemeProviderState = {
        theme: 'light',
        setTheme: vi.fn(),
      }

      const { result } = renderHook(() => useTheme(), {
        wrapper: makeWrapper(value),
      })
      expect(result.current.theme).toBe('light')
    })

    it('returns the system theme when provided', () => {
      const value: ThemeProviderState = {
        theme: 'system',
        setTheme: vi.fn(),
      }

      const { result } = renderHook(() => useTheme(), {
        wrapper: makeWrapper(value),
      })
      expect(result.current.theme).toBe('system')
    })

    it('calls setTheme when invoked through the returned context', () => {
      const setTheme = vi.fn()
      const value: ThemeProviderState = { theme: 'dark', setTheme }

      const { result } = renderHook(() => useTheme(), {
        wrapper: makeWrapper(value),
      })
      result.current.setTheme('light')
      expect(setTheme).toHaveBeenCalledWith('light')
    })
  })

  describe('边界用例 — 默认上下文', () => {
    it('returns the default context state when no provider is present', () => {
      // createContext 初始化时带有默认值（非 undefined），
      // 因此在无 Provider 的情况下使用 hook 会返回该默认值，
      // 而不会抛出错误。
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('system')
      expect(typeof result.current.setTheme).toBe('function')
    })
  })

  describe('异常用例 — context 为 undefined 时抛错', () => {
    beforeEach(() => {
      // 抑制 hook 抛错时 React 产生的预期 console.error 噪音
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('throws "useTheme must be used within a ThemeProvider" when context is undefined', () => {
      expect(() =>
        renderHook(() => useTheme(), {
          wrapper: makeWrapper(undefined as unknown as ThemeProviderState),
        })
      ).toThrow('useTheme must be used within a ThemeProvider')
    })
  })
})
