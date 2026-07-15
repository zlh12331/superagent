import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiConfigForm } from './ApiConfigForm'

// ResizeObserver polyfill 已在 src/test/setup.ts 中全局注册。

// 模拟 react-i18next — 直接返回翻译 key 以保证断言稳定
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// 模拟 toast
const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...(args as [never])),
    error: (...args: unknown[]) => mockToastError(...(args as [never])),
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

describe('ApiConfigForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 使用假定时器控制 onSubmit 中的 setTimeout
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('正向用例 — 渲染', () => {
    it('渲染所有表单字段', () => {
      render(<ApiConfigForm />)
      expect(
        screen.getByText('preferences.advanced.apiConfig.endpoint')
      ).toBeInTheDocument()
      expect(
        screen.getByText('preferences.advanced.apiConfig.apiKey')
      ).toBeInTheDocument()
      expect(
        screen.getByText('preferences.advanced.apiConfig.timeout')
      ).toBeInTheDocument()
      expect(
        screen.getByText('preferences.advanced.apiConfig.retries')
      ).toBeInTheDocument()
      expect(
        screen.getByText('preferences.advanced.apiConfig.debugMode')
      ).toBeInTheDocument()
    })

    it('渲染提交按钮', () => {
      render(<ApiConfigForm />)
      expect(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      ).toBeInTheDocument()
    })

    it('使用默认值填充表单', () => {
      render(<ApiConfigForm />)
      // endpoint 输入框 type 为 url
      const endpointInput = screen.getByPlaceholderText(
        'https://api.example.com'
      )
      expect(endpointInput).toHaveValue('')

      // 存在调试开关
      expect(
        screen.getByText('preferences.advanced.apiConfig.debugMode')
      ).toBeInTheDocument()
    })
  })

  describe('正向用例 — 表单验证与提交', () => {
    it('提交有效表单时调用 toast.success', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ApiConfigForm />)

      // 填入有效值
      await user.type(
        screen.getByPlaceholderText('https://api.example.com'),
        'https://api.example.com'
      )
      await user.type(
        screen.getByPlaceholderText(
          'preferences.advanced.apiConfig.apiKeyPlaceholder'
        ),
        'sk-1234567890' // 12 chars, >= 10
      )

      // 提交
      await user.click(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      )

      // 等待假定时器 setTimeout(800ms) 完成
      await vi.advanceTimersByTimeAsync(1000)

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          'preferences.advanced.apiConfig.saveSuccess'
        )
      })
    })

    it('提交时按钮文字变为 "saving"', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ApiConfigForm />)

      await user.type(
        screen.getByPlaceholderText('https://api.example.com'),
        'https://api.example.com'
      )
      await user.type(
        screen.getByPlaceholderText(
          'preferences.advanced.apiConfig.apiKeyPlaceholder'
        ),
        'sk-1234567890'
      )

      await user.click(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      )

      // 提交中时按钮显示 "saving" 文本
      await waitFor(() => {
        expect(
          screen.getByRole('button', {
            name: 'preferences.advanced.apiConfig.saving',
          })
        ).toBeDisabled()
      })

      // 假定时器完成后按钮恢复
      await vi.advanceTimersByTimeAsync(1000)
      await waitFor(() => {
        expect(
          screen.getByRole('button', {
            name: 'preferences.advanced.apiConfig.save',
          })
        ).toBeInTheDocument()
      })
    })
  })

  describe('异常用例 — 表单验证错误', () => {
    it('无效 URL 时显示错误消息', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ApiConfigForm />)

      await user.type(
        screen.getByPlaceholderText('https://api.example.com'),
        'not-a-url'
      )
      await user.type(
        screen.getByPlaceholderText(
          'preferences.advanced.apiConfig.apiKeyPlaceholder'
        ),
        'sk-1234567890'
      )

      await user.click(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      )

      await waitFor(() => {
        expect(
          screen.getByText('preferences.advanced.apiConfig.error.endpoint')
        ).toBeInTheDocument()
      })
      expect(mockToastSuccess).not.toHaveBeenCalled()
    })

    it('API key 不足 10 字符时显示错误消息', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ApiConfigForm />)

      await user.type(
        screen.getByPlaceholderText('https://api.example.com'),
        'https://api.example.com'
      )
      await user.type(
        screen.getByPlaceholderText(
          'preferences.advanced.apiConfig.apiKeyPlaceholder'
        ),
        'short' // < 10 chars
      )

      await user.click(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      )

      await waitFor(() => {
        expect(
          screen.getByText('preferences.advanced.apiConfig.error.apiKey')
        ).toBeInTheDocument()
      })
      expect(mockToastSuccess).not.toHaveBeenCalled()
    })

    it('空表单提交时显示多个验证错误', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ApiConfigForm />)

      await user.click(
        screen.getByRole('button', {
          name: 'preferences.advanced.apiConfig.save',
        })
      )

      await waitFor(() => {
        // endpoint 和 apiKey 均为必填
        expect(
          screen.getByText('preferences.advanced.apiConfig.error.endpoint')
        ).toBeInTheDocument()
        expect(
          screen.getByText('preferences.advanced.apiConfig.error.apiKey')
        ).toBeInTheDocument()
      })
    })
  })

  describe('边界用例', () => {
    it('表单包含 noValidate 属性(禁用浏览器原生验证)', () => {
      const { container } = render(<ApiConfigForm />)
      const form = container.querySelector('form')
      expect(form).toHaveAttribute('noValidate')
    })

    it('endpoint 输入框 type 为 url', () => {
      render(<ApiConfigForm />)
      const endpointInput = screen.getByPlaceholderText(
        'https://api.example.com'
      )
      expect(endpointInput).toHaveAttribute('type', 'url')
    })

    it('apiKey 输入框 type 为 password', () => {
      render(<ApiConfigForm />)
      const apiKeyInput = screen.getByPlaceholderText(
        'preferences.advanced.apiConfig.apiKeyPlaceholder'
      )
      expect(apiKeyInput).toHaveAttribute('type', 'password')
    })

    it('timeout 和 retry 输入框 type 为 number', () => {
      const { container } = render(<ApiConfigForm />)
      const numberInputs = container.querySelectorAll('input[type="number"]')
      expect(numberInputs.length).toBe(2)
    })
  })
})
