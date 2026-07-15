import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShortcutPicker } from './ShortcutPicker'

// 模拟 useTranslation
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// 模拟 cn 直接透传，便于断言
vi.mock('@/lib/utils', () => ({
  cn: (...inputs: (string | false | undefined | null)[]) =>
    inputs.filter(Boolean).join(' '),
}))

// 模拟平台检测 — 默认非 mac 平台以获得可预测输出
const mockGetPlatform = vi.fn<(...args: never[]) => string>()
vi.mock('@/hooks/use-platform', () => ({
  getPlatform: (...args: never[]) => mockGetPlatform(...args),
}))

describe('ShortcutPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatform.mockReturnValue('windows')
  })

  describe('正向用例 — 渲染', () => {
    it('使用 value 渲染快捷键(非 mac 平台)', () => {
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      // Windows 平台下，CommandOrControl → Ctrl，Shift 保持不变
      expect(screen.getByText('Ctrl+Shift+P')).toBeInTheDocument()
    })

    it('value 为 null 时使用 defaultValue 渲染', () => {
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      expect(screen.getByText('Ctrl+Shift+.')).toBeInTheDocument()
    })

    it('在 mac 平台上使用符号渲染快捷键', () => {
      mockGetPlatform.mockReturnValue('macos')
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      // Mac 平台下，CommandOrControl → ⌘，Shift → ⇧，移除 +
      expect(screen.getByText('⌘⇧P')).toBeInTheDocument()
    })

    it('渲染 reset 按钮当 value 不为 null 且未禁用', () => {
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      expect(screen.getByText('common.reset')).toBeInTheDocument()
    })
  })

  describe('正向用例 — 用户交互', () => {
    it('点击按钮进入捕获模式', async () => {
      const user = userEvent.setup()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)
      // 捕获时应显示 "Press shortcut..." 文本
      expect(screen.getByText('Press shortcut...')).toBeInTheDocument()
    })

    it('键盘 Enter 触发捕获模式', async () => {
      const user = userEvent.setup()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      const button = screen.getByRole('button')
      button.focus()
      await user.keyboard('{Enter}')
      expect(screen.getByText('Press shortcut...')).toBeInTheDocument()
    })

    it('点击 reset 按钮调用 onChange(null)', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+."
          onChange={onChange}
        />
      )
      const resetButton = screen.getByText('common.reset')
      await user.click(resetButton)
      expect(onChange).toHaveBeenCalledWith(null)
    })

    it('捕获到快捷键时调用 onChange(Windows 平台)', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={onChange}
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)

      // 按下 Ctrl+Shift+P
      // 需使用 fireEvent 因为我们需要原始的 window keydown/keyup 事件
      fireEvent.keyDown(window, {
        key: 'p',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
      })
      fireEvent.keyUp(window, {
        key: 'p',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
      })

      expect(onChange).toHaveBeenCalledWith('CommandOrControl+Shift+P')
    })
  })

  describe('边界用例', () => {
    it('disabled 状态下不渲染 reset 按钮', () => {
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
          disabled
        />
      )
      expect(screen.queryByText('common.reset')).not.toBeInTheDocument()
    })

    it('disabled 状态下点击按钮不进入捕获模式', async () => {
      const user = userEvent.setup()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
          disabled
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)
      expect(screen.queryByText('Press shortcut...')).not.toBeInTheDocument()
    })

    it('disabled 状态下 tabIndex 为 -1', () => {
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
          disabled
        />
      )
      expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1')
    })

    it('value 为 null 时不渲染 reset 按钮(默认值状态)', () => {
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      expect(screen.queryByText('common.reset')).not.toBeInTheDocument()
    })

    it('捕获时按 Escape 取消捕获', async () => {
      const user = userEvent.setup()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)
      expect(screen.getByText('Press shortcut...')).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
      // 应退出捕获模式
      expect(screen.queryByText('Press shortcut...')).not.toBeInTheDocument()
    })

    it('仅按修饰键不触发 onChange', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={onChange}
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)

      // 仅按 Ctrl（修饰键）
      fireEvent.keyDown(window, { key: 'Control', code: 'ControlLeft' })
      fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' })

      expect(onChange).not.toHaveBeenCalled()
    })

    it('捕获到的快捷键等于 defaultValue 时调用 onChange(null)', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      // keyEventToShortcut 使用 e.code，因此 Period 键生成 "CommandOrControl+Shift+Period"
      render(
        <ShortcutPicker
          value="CommandOrControl+Shift+P"
          defaultValue="CommandOrControl+Shift+Period"
          onChange={onChange}
        />
      )
      // value 非 null 时会渲染 reset 按钮,需精确定位 shortcut 按钮(div[role=button])
      const shortcutButton = screen
        .getByText('Ctrl+Shift+P')
        .closest('[role="button"]')
      await user.click(shortcutButton as HTMLElement)

      // 捕获默认快捷键（Period 键）
      fireEvent.keyDown(window, {
        key: '.',
        code: 'Period',
        ctrlKey: true,
        shiftKey: true,
      })
      fireEvent.keyUp(window, {
        key: '.',
        code: 'Period',
        ctrlKey: true,
        shiftKey: true,
      })

      expect(onChange).toHaveBeenCalledWith(null)
    })

    it('不带修饰键的按键不触发 onChange', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={onChange}
        />
      )
      const button = screen.getByRole('button')
      await user.click(button)

      // 仅按 'p' 不带修饰键
      fireEvent.keyDown(window, { key: 'p', code: 'KeyP' })
      fireEvent.keyUp(window, { key: 'p', code: 'KeyP' })

      expect(onChange).not.toHaveBeenCalled()
    })

    it('应用额外的 className', () => {
      render(
        <ShortcutPicker
          value={null}
          defaultValue="CommandOrControl+Shift+."
          onChange={vi.fn()}
          className="custom-class"
        />
      )
      expect(screen.getByRole('button')).toHaveClass('custom-class')
    })
  })
})
