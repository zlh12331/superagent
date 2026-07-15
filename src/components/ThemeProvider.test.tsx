import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { ThemeProvider } from './ThemeProvider'
import {
  ThemeProviderContext,
  type ThemeProviderState,
  type Theme,
} from '@/lib/theme-context'

// 模拟 @tauri-apps/api/event 的 emit
const mockEmit = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => mockEmit(...(args as [never, never])),
}))

// 模拟偏好服务
const mockUsePreferences = vi.fn()
vi.mock('@/queries/preferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

// 读取 context 值的辅助组件。
// onValue 接收 ThemeProviderState（永不为 null — createContext 提供默认值）。
function ContextReader({
  onValue,
}: {
  onValue: (value: ThemeProviderState) => void
}) {
  return (
    <ThemeProviderContext.Consumer>
      {value => {
        onValue(value)
        return <div data-testid="consumer">theme: {value.theme}</div>
      }}
    </ThemeProviderContext.Consumer>
  )
}

// 可变容器 — 对象属性不受 TypeScript 的
// 闭包窄化影响，否则会将被捕获的局部变量推断为 `never`。
function createCapture() {
  return { value: null as ThemeProviderState | null }
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    mockUsePreferences.mockReturnValue({ data: undefined })
    // 清理 Tauri 运行时标记（部分用例会设置以模拟 Tauri 环境）
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  describe('正向用例 — 初始渲染', () => {
    it('使用 defaultTheme="system" 作为初始主题', () => {
      const captured = createCapture()
      render(
        <ThemeProvider>
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )
      expect(captured.value?.theme).toBe('system')
    })

    it('从 localStorage 读取保存的主题', () => {
      localStorage.setItem('ui-theme', 'dark')
      const captured = createCapture()
      render(
        <ThemeProvider>
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )
      expect(captured.value?.theme).toBe('dark')
    })

    it('渲染 children', () => {
      render(
        <ThemeProvider>
          <div data-testid="child">Hello</div>
        </ThemeProvider>
      )
      expect(screen.getByTestId('child')).toBeInTheDocument()
    })
  })

  describe('正向用例 — 主题应用', () => {
    it('dark 主题时给 documentElement 添加 "dark" class', () => {
      render(
        <ThemeProvider defaultTheme="dark">
          <div />
        </ThemeProvider>
      )
      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(document.documentElement.classList.contains('light')).toBe(false)
    })

    it('light 主题时给 documentElement 添加 "light" class', () => {
      render(
        <ThemeProvider defaultTheme="light">
          <div />
        </ThemeProvider>
      )
      expect(document.documentElement.classList.contains('light')).toBe(true)
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('system 主题根据 prefers-color-scheme 决定', () => {
      // matchMedia 在 setup.ts 中被模拟为返回 matches: false
      render(
        <ThemeProvider defaultTheme="system">
          <div />
        </ThemeProvider>
      )
      // matches: false → light
      expect(document.documentElement.classList.contains('light')).toBe(true)
    })
  })

  describe('正向用例 — setTheme', () => {
    it('调用 setTheme 时更新 context 值', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )

      act(() => {
        captured.value?.setTheme('dark' as Theme)
      })

      expect(screen.getByTestId('consumer')).toHaveTextContent('theme: dark')
    })

    it('调用 setTheme 时保存到 localStorage', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )

      act(() => {
        captured.value?.setTheme('dark' as Theme)
      })

      expect(localStorage.getItem('ui-theme')).toBe('dark')
    })

    it('调用 setTheme 时发送 theme-changed 事件', () => {
      // 模拟 Tauri 运行环境：isTauri() 依据 window.__TAURI_INTERNALS__ 判定，
      // 仅在 Tauri 环境下 setTheme 才 emit 跨窗口事件
      // （浏览器模式跳过 emit 以避免抛异常）。
      ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )

      act(() => {
        captured.value?.setTheme('dark' as Theme)
      })

      expect(mockEmit).toHaveBeenCalledWith('theme-changed', { theme: 'dark' })
    })

    it('切换主题时更新 documentElement class', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )

      act(() => {
        captured.value?.setTheme('dark' as Theme)
      })

      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(document.documentElement.classList.contains('light')).toBe(false)
    })
  })

  describe('正向用例 — 偏好同步', () => {
    it('preferences 加载后同步主题(仅一次)', async () => {
      // 无偏好时的初始渲染
      const { rerender } = render(
        <ThemeProvider defaultTheme="light">
          <div data-testid="child" />
        </ThemeProvider>
      )
      expect(document.documentElement.classList.contains('light')).toBe(true)

      // 模拟加载偏好，theme: 'dark'
      mockUsePreferences.mockReturnValue({
        data: {
          theme: 'dark',
          quick_pane_shortcut: null,
          language: null,
          crash_reporting_consent: null,
        },
      })

      await act(async () => {
        rerender(
          <ThemeProvider defaultTheme="light">
            <div data-testid="child" />
          </ThemeProvider>
        )
      })

      // 主题应从偏好同步为 'dark'
      // setTheme 通过 queueMicrotask 延迟执行，需等待
      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true)
      })
    })

    it('preferences.theme 未定义时不覆盖当前主题', () => {
      mockUsePreferences.mockReturnValue({ data: undefined })
      render(
        <ThemeProvider defaultTheme="light">
          <div />
        </ThemeProvider>
      )
      expect(document.documentElement.classList.contains('light')).toBe(true)
    })
  })

  describe('边界用例', () => {
    it('localStorage 为空时使用 defaultTheme', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="dark">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )
      expect(captured.value?.theme).toBe('dark')
    })

    it('使用自定义 defaultTheme', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )
      expect(captured.value?.theme).toBe('light')
    })

    it('storageKey 默认为 "ui-theme"', () => {
      const captured = createCapture()
      render(
        <ThemeProvider defaultTheme="light">
          <ContextReader
            onValue={v => {
              captured.value = v
            }}
          />
        </ThemeProvider>
      )

      act(() => {
        captured.value?.setTheme('dark' as Theme)
      })

      expect(localStorage.getItem('ui-theme')).toBe('dark')
    })

    it('preferences 同步只发生一次(后续 theme 变化不触发)', async () => {
      // 首次渲染：偏好中 theme 为 'dark'
      mockUsePreferences.mockReturnValue({
        data: {
          theme: 'dark',
          quick_pane_shortcut: null,
          language: null,
          crash_reporting_consent: null,
        },
      })

      const { rerender } = render(
        <ThemeProvider defaultTheme="light">
          <div />
        </ThemeProvider>
      )
      // setTheme 通过 queueMicrotask 延迟执行，需等待
      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true)
      })

      // 现在偏好中 theme 变为 'light' — 不应覆盖
      // 因为 hasSyncedPreferences ref 已为 true
      mockUsePreferences.mockReturnValue({
        data: {
          theme: 'light',
          quick_pane_shortcut: null,
          language: null,
          crash_reporting_consent: null,
        },
      })

      await act(async () => {
        rerender(
          <ThemeProvider defaultTheme="light">
            <div />
          </ThemeProvider>
        )
      })

      // 应仍为 'dark'，因为同步只发生一次
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })
})
