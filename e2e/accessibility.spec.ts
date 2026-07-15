import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

/**
 * 打开偏好设置（设置抽屉）。
 * 返回一个限定在设置对话框上的定位器。
 */
async function openPreferences(page: Page) {
  // 等待应用加载完成（侧栏可见表示 UI 已渲染）
  await expect(
    page.getByRole('complementary', { name: /会话侧栏/i })
  ).toBeVisible({ timeout: 15000 })
  // 按 Ctrl+, 打开设置抽屉（不再通过命令面板）
  await page.keyboard.press('Control+,')
  // 等待设置对话框可见
  const dialog = page.getByRole('dialog', { name: /设置/i })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('Accessibility (WCAG 2.1 AA)', () => {
  // AxeBuilder 分析 + Vite dev server 冷启动需要额外时间。
  // 主窗口含大量 DOM 节点（会话列表、对话区、上下文面板等），
  // 即使排除了 .xterm，分析仍需较长时间，设为 90s 留足余量。
  test.setTimeout(90000)

  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
    })
  })

  test('main window has no accessibility violations', async ({
    mockPage,
    analyzeA11y,
  }) => {
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({
      timeout: 15000,
    })
    await analyzeA11y(mockPage)
  })

  test('command palette has no accessibility violations', async ({
    mockPage,
    analyzeA11y,
  }) => {
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({
      timeout: 15000,
    })
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeVisible()
    await analyzeA11y(mockPage)
  })

  test('preferences dialog has no accessibility violations', async ({
    mockPage,
    analyzeA11y,
  }) => {
    await openPreferences(mockPage)
    await analyzeA11y(mockPage)
  })

  test('preferences appearance tab has no accessibility violations', async ({
    mockPage,
    analyzeA11y,
  }) => {
    const dialog = await openPreferences(mockPage)
    // 新 UI 导航用 role="tab"，文本为中文 "外观"
    const nav = dialog.locator('nav[role="tablist"][aria-label="设置分区"]')
    await nav.getByRole('tab', { name: '外观' }).click()
    // 新 UI AppearanceSettingsPane 渲染 "颜色主题" 文本（SegControl 而非 Select combobox）
    await expect(dialog.getByText('颜色主题')).toBeVisible()
    await analyzeA11y(mockPage)
  })

  test('preferences advanced tab has no accessibility violations', async ({
    mockPage,
    analyzeA11y,
  }) => {
    const dialog = await openPreferences(mockPage)
    // 新 UI 导航用 role="tab"，文本为中文 "高级"
    const nav = dialog.locator('nav[role="tablist"][aria-label="设置分区"]')
    await nav.getByRole('tab', { name: '高级' }).click()
    // 新 UI AdvancedSettingsPane 渲染 "实验功能" 文本
    await expect(dialog.getByText('实验功能')).toBeVisible()
    await analyzeA11y(mockPage)
  })
})
