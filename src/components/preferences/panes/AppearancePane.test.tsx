import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppearancePane } from './AppearancePane'

// Pointer capture、scrollIntoView 和 ResizeObserver polyfill
// 已在 src/test/setup.ts 中全局注册。

// 模拟 react-i18next — 直接返回 key 以保证断言稳定
const mockChangeLanguage = vi.fn()
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'en',
      changeLanguage: (...args: unknown[]) =>
        mockChangeLanguage(...(args as [never])),
    },
  }),
}))

// 模拟 toast
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...(args as [never])),
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

// 模拟 @tauri-apps/plugin-os 的 locale 函数
const mockLocale = vi.fn()
vi.mock('@tauri-apps/plugin-os', () => ({
  locale: (...args: unknown[]) => mockLocale(...(args as [])),
}))

// 模拟主题 hook
const mockSetTheme = vi.fn()
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: (...args: unknown[]) => mockSetTheme(...(args as [never])),
  }),
}))

// 模拟偏好服务
const mockUsePreferences = vi.fn()
const mockMutate = vi.fn()
vi.mock('@/queries/preferences', () => ({
  usePreferences: () => mockUsePreferences(),
  useSavePreferences: () => ({
    mutate: (...args: unknown[]) => mockMutate(...(args as [never])),
    isPending: false,
  }),
}))

// 模拟 i18n 的 availableLanguages — 被 AppearancePane 使用
vi.mock('@/i18n', () => ({
  availableLanguages: ['en', 'zh'],
  loadLanguageAsync: vi.fn().mockResolvedValue(undefined),
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

describe('AppearancePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUsePreferences.mockReturnValue({
      data: defaultPrefs,
      isLoading: false,
    })
    mockChangeLanguage.mockResolvedValue(undefined)
    mockLocale.mockResolvedValue('en-US')
    mockMutate.mockReturnValue(undefined)
  })

  describe('正向用例 — 渲染', () => {
    it('渲染语言和主题区块标题', () => {
      renderWithClient(<AppearancePane />)
      // 两个区块标题分别为 "preferences.appearance.language" 和 "preferences.appearance.theme"
      expect(
        screen.getAllByText('preferences.appearance.language').length
      ).toBeGreaterThan(0)
      expect(
        screen.getByText('preferences.appearance.theme')
      ).toBeInTheDocument()
    })

    it('渲染语言选择器和主题选择器', () => {
      renderWithClient(<AppearancePane />)
      // 两个 Select 触发器（combobox 角色）
      const triggers = screen.getAllByRole('combobox')
      expect(triggers.length).toBe(2)
    })

    it('语言选择器默认值为 "system" (language 为 null)', () => {
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: null },
      })
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      // 第一个触发器是语言选择器
      expect(triggers[0]).toHaveTextContent(
        'preferences.appearance.language.system'
      )
    })

    it('语言选择器使用保存的 language 值', () => {
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: 'zh' },
      })
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      expect(triggers[0]).toHaveTextContent('中文')
    })
  })

  describe('正向用例 — 用户交互', () => {
    it('点击语言选择器打开下拉菜单', async () => {
      const user = userEvent.setup()
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      // 选项使用 role="option" 避免与 trigger 文本重复
      await waitFor(() => {
        expect(
          screen.getByRole('option', {
            name: 'preferences.appearance.language.system',
          })
        ).toBeInTheDocument()
      })
      expect(
        screen.getByRole('option', { name: 'English' })
      ).toBeInTheDocument()
      expect(screen.getByRole('option', { name: '中文' })).toBeInTheDocument()
    })

    it('选择英语语言调用 i18n.changeLanguage("en") 并保存偏好', async () => {
      const user = userEvent.setup()
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)

      // 点击 "English" 选项
      await user.click(screen.getByText('English'))

      await waitFor(() => {
        expect(mockChangeLanguage).toHaveBeenCalledWith('en')
      })
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith({
          ...defaultPrefs,
          language: 'en',
        })
      })
    })

    it('选择 "System" 语言调用 locale() 检测系统语言', async () => {
      const user = userEvent.setup()
      // 此前 language 为 'zh'，现选择 'system'
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: 'zh' },
      })
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      await user.click(
        screen.getByText('preferences.appearance.language.system')
      )

      await waitFor(() => {
        expect(mockLocale).toHaveBeenCalledTimes(1)
      })
      await waitFor(() => {
        expect(mockChangeLanguage).toHaveBeenCalledWith('en')
      })
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith({
          ...defaultPrefs,
          language: null,
        })
      })
    })

    it('点击主题选择器打开下拉菜单并显示选项', async () => {
      const user = userEvent.setup()
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[1] as HTMLElement)

      await waitFor(() => {
        expect(
          screen.getByRole('option', {
            name: 'preferences.appearance.theme.light',
          })
        ).toBeInTheDocument()
      })
      expect(
        screen.getByRole('option', {
          name: 'preferences.appearance.theme.dark',
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('option', {
          name: 'preferences.appearance.theme.system',
        })
      ).toBeInTheDocument()
    })

    it('选择 dark 主题调用 setTheme("dark") 并保存偏好', async () => {
      const user = userEvent.setup()
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[1] as HTMLElement)

      await user.click(screen.getByText('preferences.appearance.theme.dark'))

      expect(mockSetTheme).toHaveBeenCalledWith('dark')
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith({
          ...defaultPrefs,
          theme: 'dark',
        })
      })
    })
  })

  describe('边界用例', () => {
    it('preferences 为 undefined 时不调用 mutate (主题切换)', async () => {
      const user = userEvent.setup()
      mockUsePreferences.mockReturnValue({ data: undefined })
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[1] as HTMLElement)
      await user.click(screen.getByText('preferences.appearance.theme.dark'))

      // 仍调用 setTheme 以实现即时反馈
      expect(mockSetTheme).toHaveBeenCalledWith('dark')
      // 但 mutate 不会被调用，因为 preferences 为 undefined
      expect(mockMutate).not.toHaveBeenCalled()
    })

    it('系统 locale 包含未知语言时回退到 "en"', async () => {
      const user = userEvent.setup()
      mockLocale.mockResolvedValue('de-DE') // de not in availableLanguages
      // 初始语言设为 zh,这样选择 system 才会触发 onValueChange
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: 'zh' },
      })
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      await user.click(
        screen.getByRole('option', {
          name: 'preferences.appearance.language.system',
        })
      )

      await waitFor(() => {
        expect(mockChangeLanguage).toHaveBeenCalledWith('en')
      })
    })

    it('locale() 返回 null 时回退到 "en"', async () => {
      const user = userEvent.setup()
      mockLocale.mockResolvedValue(null)
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: 'zh' },
      })
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      await user.click(
        screen.getByRole('option', {
          name: 'preferences.appearance.language.system',
        })
      )

      await waitFor(() => {
        expect(mockChangeLanguage).toHaveBeenCalledWith('en')
      })
    })

    it('savePreferences.isPending 默认为 false 时选择器可用', () => {
      // 默认 mock 返回 isPending: false,选择器应可用
      renderWithClient(<AppearancePane />)
      const triggers = screen.getAllByRole('combobox')
      expect(triggers[0] as HTMLElement).not.toBeDisabled()
    })
  })

  describe('异常用例', () => {
    it('i18n.changeLanguage 抛错时显示错误 toast 且不保存偏好', async () => {
      const user = userEvent.setup()
      mockChangeLanguage.mockRejectedValue(new Error('lang fail'))
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      await user.click(screen.getByText('English'))

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('toast.error.generic')
      })
      expect(mockMutate).not.toHaveBeenCalled()
    })

    it('locale() 抛错时显示错误 toast', async () => {
      const user = userEvent.setup()
      mockLocale.mockRejectedValue(new Error('locale fail'))
      mockUsePreferences.mockReturnValue({
        data: { ...defaultPrefs, language: 'zh' },
      })
      renderWithClient(<AppearancePane />)

      const triggers = screen.getAllByRole('combobox')
      await user.click(triggers[0] as HTMLElement)
      await user.click(
        screen.getByRole('option', {
          name: 'preferences.appearance.language.system',
        })
      )

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('toast.error.generic')
      })
    })
  })
})
