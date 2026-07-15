import { test, expect } from './fixtures'

test.describe('App Launch', () => {
  test.use({ navigationTimeout: 30000 })

  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/')
  })

  test('app launches and renders the main window', async ({ mockPage }) => {
    await expect(mockPage.locator('body')).toBeVisible({ timeout: 15000 })
  })

  test('title bar is visible with correct content', async ({ mockPage }) => {
    // 标题栏显示居中的 "Tauri App" 标签
    await expect(mockPage.getByText('Tauri App')).toBeVisible({
      timeout: 15000,
    })

    // 标题栏按钮通过 `title` 属性识别。
    // sidebar 默认可见，因此 toggle 按钮显示 "Hide ..."。
    const leftSidebarButton = mockPage.locator(
      'button[title="Show Left Sidebar"], button[title="Hide Left Sidebar"]'
    )
    const settingsButton = mockPage.locator('button[title="Settings"]')
    const rightSidebarButton = mockPage.locator(
      'button[title="Show Right Sidebar"], button[title="Hide Right Sidebar"]'
    )

    await expect(leftSidebarButton).toBeVisible({ timeout: 15000 })
    await expect(settingsButton).toBeVisible({ timeout: 15000 })
    await expect(rightSidebarButton).toBeVisible({ timeout: 15000 })
  })

  test('app shows the default content area', async ({ mockPage }) => {
    // 新 UI 已移除旧版默认标题，改为验证会话侧栏渲染。
    // 侧栏（aside 元素，aria-label 为 "会话侧栏"）是应用主界面的核心组成，
    // 其可见即代表默认内容区已成功渲染。
    const sessionSidebar = mockPage.getByRole('complementary', {
      name: /会话侧栏/i,
    })
    await expect(sessionSidebar).toBeVisible({ timeout: 15000 })
  })
})
