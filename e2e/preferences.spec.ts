import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

test.describe('Preferences dialog', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({
      timeout: 15000,
    })
  })

  /**
   * 打开偏好设置（设置抽屉）。
   *
   * 使用 Ctrl+, 快捷键直接打开设置抽屉（不再通过命令面板）。
   * 返回一个限定在设置对话框上的定位器，供后续断言使用。
   */
  async function openPreferences(page: Page) {
    // 按 Ctrl+, 打开设置抽屉
    await page.keyboard.press('Control+,')

    // 等待设置对话框可见
    const dialog = page.getByRole('dialog', { name: /设置/i })
    await expect(dialog).toBeVisible()
    return dialog
  }

  test('opens and shows the title "设置"', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    // 新 UI 设置抽屉的 header 中显示 "设置" 文本（PreferencesDialog.tsx 第 177 行）
    // SheetTitle 为 sr-only "设置"，header 中还有可见的 "设置" span
    await expect(dialog.getByText('设置', { exact: true }).first()).toBeVisible()
  })

  test('shows navigation tabs (通用, 外观, 高级)', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    // 新 UI 导航是 nav[role="tablist"][aria-label="设置分区"]，
    // 包含 button[role="tab"]，文本为中文
    const nav = dialog.locator('nav[role="tablist"][aria-label="设置分区"]')
    await expect(nav).toBeVisible()

    // 验证关键分区导航项存在
    await expect(nav.getByRole('tab', { name: '通用' })).toBeVisible()
    await expect(nav.getByRole('tab', { name: '外观' })).toBeVisible()
    await expect(nav.getByRole('tab', { name: '高级' })).toBeVisible()
  })

  test('switching to Appearance tab shows theme options (暗色, 浅色, 跟随系统)', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    const nav = dialog.locator('nav[role="tablist"][aria-label="设置分区"]')
    await nav.getByRole('tab', { name: '外观' }).click()

    // 新 UI AppearanceSettingsPane 使用 SegControl（不是 Select combobox），
    // 渲染 "颜色主题" 标签和 暗色/浅色/跟随系统 三个选项
    await expect(dialog.getByText('颜色主题')).toBeVisible()
    await expect(dialog.getByText('暗色', { exact: true })).toBeVisible()
    await expect(dialog.getByText('浅色', { exact: true })).toBeVisible()
    await expect(dialog.getByText('跟随系统', { exact: true })).toBeVisible()
  })

  test('switching to Advanced tab shows experimental features', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    const nav = dialog.locator('nav[role="tablist"][aria-label="设置分区"]')
    await nav.getByRole('tab', { name: '高级' }).click()

    // 新 UI AdvancedSettingsPane 渲染 "实验功能" 和 "命令白名单" 标题，
    // 而非旧版的 "API Configuration"
    await expect(dialog.getByText('实验功能')).toBeVisible()
    await expect(dialog.getByText('命令白名单')).toBeVisible()
  })

  test.describe('closing the preferences dialog', () => {
    test('can be closed via the Escape key', async ({ mockPage }) => {
      const dialog = await openPreferences(mockPage)

      await mockPage.keyboard.press('Escape')

      await expect(dialog).not.toBeVisible()
    })

    test('can be closed via the Close button', async ({ mockPage }) => {
      const dialog = await openPreferences(mockPage)

      await dialog.getByRole('button', { name: /close/i }).click()

      await expect(dialog).not.toBeVisible()
    })
  })
})
