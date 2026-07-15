import { test, expect } from './fixtures'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

test.describe('Command Palette', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('/')
    // 等待应用加载完成（侧栏可见表示 UI 已渲染），避免页面未就绪时按快捷键
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({ timeout: 15000 })
  })

  test('opens with keyboard shortcut (Ctrl+K on Windows/Linux, Meta+K on macOS)', async ({
    mockPage,
  }) => {
    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeHidden()

    await mockPage.keyboard.press(`${modifierKey}+k`)

    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeVisible()
  })

  test('search input is visible and focused when opened', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search/i)
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
  })

  test('typing in search filters commands', async ({ mockPage }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search/i)
    await searchInput.fill('sidebar')

    // sidebar 相关命令被过滤并显示。cmdk 按
    // 命令 value/label 过滤，因此不匹配的命令（如 "Close Window"）
    // 不再渲染。toBeVisible() 会自动等待列表更新。
    await expect(mockPage.getByText(/left sidebar/i).first()).toBeVisible()
    await expect(mockPage.getByText(/right sidebar/i).first()).toBeVisible()
  })

  test('shows "No results found" for non-matching search', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search/i)
    await searchInput.fill('zzzznonexistentcommand')

    await expect(mockPage.getByText(/no results found/i)).toBeVisible()
  })

  test('navigating to a command and pressing Enter executes it', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search/i)
    await searchInput.fill('preferences')

    const preferencesCommand = mockPage.getByText(/open preferences/i)
    await expect(preferencesCommand).toBeVisible()

    await mockPage.keyboard.press('Enter')

    // 命令执行后命令面板应关闭
    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeHidden()
    // 新 UI 设置抽屉的 SheetTitle 是 "设置"（sr-only），对话框 accessible name 为 "设置"
    await expect(
      mockPage.getByRole('dialog', { name: /设置/i })
    ).toBeVisible()
  })
})
