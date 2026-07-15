import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSidebarStore } from '@/store/sidebar-store'
import { LinuxTitleBar } from './LinuxTitleBar'

// 模拟 react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// 模拟 @/lib/commands 中的 executeCommand
const mockExecuteCommand = vi.fn()
vi.mock('@/lib/commands', () => ({
  executeCommand: (...args: unknown[]) =>
    mockExecuteCommand(...(args as [never, never])),
}))

// 模拟自身模块中的 useCommandContext
vi.mock('@/hooks/use-command-context', () => ({
  useCommandContext: () => ({
    openPreferences: vi.fn(),
    showToast: vi.fn(),
  }),
}))

describe('LinuxTitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSidebarStore.setState({
      leftSidebarVisible: true,
      rightSidebarVisible: true,
    })
    mockExecuteCommand.mockResolvedValue({ success: true })
  })

  describe('正向用例 — 渲染', () => {
    it('渲染传入的 title', () => {
      render(<LinuxTitleBar title="My App" />)
      expect(screen.getByText('My App')).toBeInTheDocument()
    })

    it('未传 title 时不渲染 title 文本', () => {
      render(<LinuxTitleBar />)
      // 仅验证不崩溃且渲染了工具栏按钮
      expect(screen.getByTitle('titlebar.settings')).toBeInTheDocument()
    })

    it('渲染左侧栏切换按钮', () => {
      render(<LinuxTitleBar title="Test" />)
      expect(screen.getByTitle('titlebar.hideLeftSidebar')).toBeInTheDocument()
    })

    it('渲染设置按钮', () => {
      render(<LinuxTitleBar title="Test" />)
      expect(screen.getByTitle('titlebar.settings')).toBeInTheDocument()
    })

    it('渲染右侧栏切换按钮', () => {
      render(<LinuxTitleBar title="Test" />)
      expect(screen.getByTitle('titlebar.hideRightSidebar')).toBeInTheDocument()
    })

    it('应用额外的 className', () => {
      const { container } = render(
        <LinuxTitleBar title="Test" className="custom-class" />
      )
      expect(container.firstChild).toHaveClass('custom-class')
    })
  })

  describe('边界用例', () => {
    it('空字符串 title 仍能渲染', () => {
      render(<LinuxTitleBar title="" />)
      // 不应崩溃；工具栏仍然渲染
      expect(screen.getByTitle('titlebar.settings')).toBeInTheDocument()
    })

    it('leftSidebarVisible=false 时按钮 title 为 showLeftSidebar', () => {
      useSidebarStore.setState({ leftSidebarVisible: false })
      render(<LinuxTitleBar title="Test" />)
      expect(screen.getByTitle('titlebar.showLeftSidebar')).toBeInTheDocument()
    })

    it('rightSidebarVisible=false 时按钮 title 为 showRightSidebar', () => {
      useSidebarStore.setState({ rightSidebarVisible: false })
      render(<LinuxTitleBar title="Test" />)
      expect(screen.getByTitle('titlebar.showRightSidebar')).toBeInTheDocument()
    })
  })
})
