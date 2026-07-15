import { render, act } from '@/test/test-utils'
import { screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import App from './App'

// Tauri 绑定已在 src/test/setup.ts 中全局 mock

describe('App', () => {
  it('renders main window with sidebar', async () => {
    await act(async () => {
      render(<App />)
    })
    // 主窗口应渲染侧栏（aside 元素，aria-label 为 "会话侧栏"）
    expect(
      screen.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeInTheDocument()
  })

  it('renders new thread button in sidebar', async () => {
    await act(async () => {
      render(<App />)
    })
    // 侧栏应包含"新建会话"按钮（可能有多个：主按钮 + 文件夹内新建按钮）
    const newThreadButtons = screen.getAllByRole('button', {
      name: /新建会话/i,
    })
    expect(newThreadButtons.length).toBeGreaterThan(0)
  })
})
