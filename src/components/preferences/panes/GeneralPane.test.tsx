import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GeneralPane } from './GeneralPane'

// Pointer capture 和 scrollIntoView polyfill 已在全局注册
// （位于 src/test/setup.ts）。

// 模拟 react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// 模拟 toast
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...(args as [never, never])),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

// 模拟 logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}))

// 模拟 tauri 绑定 — 包含 GeneralPane 用到的所有命令
const mockGetDefaultQuickPaneShortcut = vi.fn()
const mockUpdateQuickPaneShortcut = vi.fn()
vi.mock('@/lib/tauri-bindings', () => ({
  commands: {
    getDefaultQuickPaneShortcut: (...args: unknown[]) =>
      mockGetDefaultQuickPaneShortcut(...(args as [])),
    updateQuickPaneShortcut: (...args: unknown[]) =>
      mockUpdateQuickPaneShortcut(...(args as [never])),
  },
}))

// 模拟偏好服务
const mockUsePreferences = vi.fn()
const mockMutateAsync = vi.fn()
const mockMutate = vi.fn()
vi.mock('@/queries/preferences', () => ({
  usePreferences: () => mockUsePreferences(),
  useSavePreferences: () => ({
    mutateAsync: (...args: unknown[]) => mockMutateAsync(...(args as [never])),
    mutate: (...args: unknown[]) => mockMutate(...(args as [never])),
    isPending: false,
  }),
}))

// 模拟 autostart 插件
const mockEnableAutostart = vi.fn()
const mockDisableAutostart = vi.fn()
const mockIsAutostartEnabled = vi.fn()
vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: (...args: unknown[]) => mockEnableAutostart(...(args as [])),
  disable: (...args: unknown[]) => mockDisableAutostart(...(args as [])),
  isEnabled: (...args: unknown[]) => mockIsAutostartEnabled(...(args as [])),
}))

// 模拟平台检测，使 ShortcutPicker 可预测地渲染
vi.mock('@/hooks/use-platform', () => ({
  getPlatform: () => 'windows',
}))

const defaultPrefs = {
  theme: 'system',
  quick_pane_shortcut: null,
  language: null,
  crash_reporting_consent: null,
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  )
}

describe('GeneralPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUsePreferences.mockReturnValue({
      data: defaultPrefs,
      isLoading: false,
    })
    mockGetDefaultQuickPaneShortcut.mockResolvedValue(
      'CommandOrControl+Shift+.'
    )
    mockUpdateQuickPaneShortcut.mockResolvedValue({
      status: 'ok',
      data: null,
    })
    mockMutateAsync.mockResolvedValue(undefined)
    mockMutate.mockReturnValue(undefined)
    mockIsAutostartEnabled.mockResolvedValue(false)
    mockEnableAutostart.mockResolvedValue(undefined)
    mockDisableAutostart.mockResolvedValue(undefined)
  })

  describe('正向用例 — 渲染', () => {
    it('渲染所有 section 标题', () => {
      renderWithClient(<GeneralPane />)
      expect(
        screen.getByText('preferences.general.keyboardShortcuts')
      ).toBeInTheDocument()
      expect(screen.getByText('preferences.general.system')).toBeInTheDocument()
      expect(
        screen.getByText('preferences.general.exampleSettings')
      ).toBeInTheDocument()
    })

    it('渲染 example text 输入框', () => {
      renderWithClient(<GeneralPane />)
      expect(
        screen.getByPlaceholderText(
          'preferences.general.exampleTextPlaceholder'
        )
      ).toBeInTheDocument()
    })

    it('渲染 autostart 开关 (id="autostart-toggle")', () => {
      renderWithClient(<GeneralPane />)
      const toggle = document.getElementById('autostart-toggle')
      expect(toggle).toBeInTheDocument()
    })

    it('渲染 example toggle 开关 (id="example-toggle")', () => {
      renderWithClient(<GeneralPane />)
      const toggle = document.getElementById('example-toggle')
      expect(toggle).toBeInTheDocument()
    })

    it('挂载时查询默认快捷键', async () => {
      renderWithClient(<GeneralPane />)
      await waitFor(() => {
        expect(mockGetDefaultQuickPaneShortcut).toHaveBeenCalledTimes(1)
      })
    })

    it('挂载时查询 autostart 状态', async () => {
      renderWithClient(<GeneralPane />)
      await waitFor(() => {
        expect(mockIsAutostartEnabled).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('正向用例 — 用户交互', () => {
    it('在 example text 输入框输入文字时更新值', async () => {
      const user = userEvent.setup()
      renderWithClient(<GeneralPane />)
      const input = screen.getByPlaceholderText(
        'preferences.general.exampleTextPlaceholder'
      )
      await user.clear(input)
      await user.type(input, 'hello world')
      expect(input).toHaveValue('hello world')
    })

    it('切换 example toggle 开关', () => {
      renderWithClient(<GeneralPane />)
      // 初始显示禁用文本
      expect(screen.getAllByText('common.disabled').length).toBeGreaterThan(0)

      const exampleToggle = document.getElementById(
        'example-toggle'
      ) as HTMLElement
      // Radix Switch 在 jsdom 中对 pointer 事件支持有限,改用键盘 Space 切换
      exampleToggle.focus()
      fireEvent.keyDown(exampleToggle, { key: ' ', code: 'Space' })
      fireEvent.keyUp(exampleToggle, { key: ' ', code: 'Space' })

      // 现在应显示启用文本
      expect(screen.getAllByText('common.enabled').length).toBeGreaterThan(0)
    })

    it('启用 autostart 时调用 enableAutostart 并刷新查询', async () => {
      const user = userEvent.setup()
      mockIsAutostartEnabled.mockResolvedValue(false)
      renderWithClient(<GeneralPane />)

      await waitFor(() => {
        expect(mockIsAutostartEnabled).toHaveBeenCalled()
      })

      const autostartToggle = document.getElementById(
        'autostart-toggle'
      ) as HTMLElement
      await user.click(autostartToggle)

      await waitFor(() => {
        expect(mockEnableAutostart).toHaveBeenCalledTimes(1)
      })
    })

    it('禁用 autostart 时调用 disableAutostart', async () => {
      const user = userEvent.setup()
      mockIsAutostartEnabled.mockResolvedValue(true)
      renderWithClient(<GeneralPane />)

      await waitFor(() => {
        expect(mockIsAutostartEnabled).toHaveBeenCalled()
      })

      const autostartToggle = document.getElementById(
        'autostart-toggle'
      ) as HTMLElement
      // 开关已选中，因为 autostart 已启用
      await waitFor(() => {
        expect(autostartToggle).toHaveAttribute('data-state', 'checked')
      })

      await user.click(autostartToggle)

      await waitFor(() => {
        expect(mockDisableAutostart).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('边界用例', () => {
    it('preferences 为 undefined 时 ShortcutPicker 仍渲染默认值', () => {
      mockUsePreferences.mockReturnValue({ data: undefined, isLoading: true })
      renderWithClient(<GeneralPane />)
      // ShortcutPicker 使用 div[role="button"],disabled 通过 tabindex=-1 和 CSS 类实现
      const shortcutButtons = screen.getAllByRole('button')
      // 找到包含快捷键文本的按钮(ShortcutPicker)
      const shortcutButton = shortcutButtons.find(btn =>
        btn.textContent?.includes('Ctrl')
      )
      expect(shortcutButton).toBeDefined()
      expect(shortcutButton).toHaveAttribute('tabindex', '-1')
    })

    it('autostart 查询 loading 时开关被禁用', () => {
      //isLoading 标志来自 useQuery — 可通过让 isEnabled 处于 pending 状态来模拟
      mockIsAutostartEnabled.mockReturnValue(
        new Promise<never>(() => undefined)
      )
      renderWithClient(<GeneralPane />)
      const autostartToggle = document.getElementById('autostart-toggle')
      // 加载中时开关被禁用
      expect(autostartToggle).toBeDisabled()
    })

    it('默认快捷键查询失败时使用 fallback "CommandOrControl+Shift+."', async () => {
      mockGetDefaultQuickPaneShortcut.mockRejectedValue(new Error('fail'))
      renderWithClient(<GeneralPane />)
      // 仍应使用兜底值渲染（不崩溃）
      expect(
        screen.getByText('preferences.general.quickPaneShortcut')
      ).toBeInTheDocument()
    })
  })

  describe('异常用例', () => {
    it('autostart 切换抛错时显示错误 toast', async () => {
      const user = userEvent.setup()
      mockEnableAutostart.mockRejectedValue(new Error('permission denied'))
      renderWithClient(<GeneralPane />)

      await waitFor(() => {
        expect(mockIsAutostartEnabled).toHaveBeenCalled()
      })

      const autostartToggle = document.getElementById(
        'autostart-toggle'
      ) as HTMLElement
      await user.click(autostartToggle)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'preferences.general.launchOnBootEnableFailed'
        )
      })
    })

    it('禁用 autostart 抛错时显示禁用失败的 toast', async () => {
      const user = userEvent.setup()
      mockIsAutostartEnabled.mockResolvedValue(true)
      mockDisableAutostart.mockRejectedValue(new Error('fail'))

      renderWithClient(<GeneralPane />)

      await waitFor(() => {
        expect(mockIsAutostartEnabled).toHaveBeenCalled()
      })

      const autostartToggle = document.getElementById(
        'autostart-toggle'
      ) as HTMLElement
      await waitFor(() => {
        expect(autostartToggle).toHaveAttribute('data-state', 'checked')
      })

      await user.click(autostartToggle)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'preferences.general.launchOnBootDisableFailed'
        )
      })
    })
  })
})
