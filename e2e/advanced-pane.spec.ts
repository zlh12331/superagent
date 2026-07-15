import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

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

// 旧测试针对 Tauri 模板的 AdvancedPane（Example Advanced Settings / Crash Reporting / API Configuration form）。
// 新 UI 的 AdvancedSettingsPane（SettingsPanes.tsx）功能完全不同（实验功能 / 命令白名单），
// 旧功能在新 UI 中不存在。新 UI 的高级分区测试由 codex-extended.spec.ts test 9 覆盖。
test.describe.skip('Advanced Preferences Pane (legacy — 新 UI 已重构)', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
    })
  })

  test('shows Example Advanced Settings section', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    await expect(
      dialog.getByRole('heading', { name: 'Example Advanced Settings' })
    ).toBeVisible()
  })

  test('advanced toggle switches state', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    const toggle = dialog.locator('#example-advanced-toggle')
    await expect(toggle).not.toBeChecked()

    await toggle.click()
    await expect(toggle).toBeChecked()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
  })

  test('advanced dropdown shows 3 options and can switch', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    // 打开原生 select 下拉框
    const dropdown = dialog.getByRole('combobox')
    await dropdown.click()

    // 验证 3 个选项都存在
    await expect(
      mockPage.getByRole('option', { name: 'Example Option 1' })
    ).toBeVisible()
    await expect(
      mockPage.getByRole('option', { name: 'Example Option 2' })
    ).toBeVisible()
    await expect(
      mockPage.getByRole('option', { name: 'Example Option 3' })
    ).toBeVisible()

    // 选择 Option 2
    await mockPage.getByRole('option', { name: 'Example Option 2' }).click()

    // 验证 trigger 现在显示 Option 2
    await expect(dropdown).toContainText('Example Option 2')
  })

  test('crash reporting section is visible', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    await expect(
      dialog.getByRole('heading', { name: 'Crash Reporting' })
    ).toBeVisible()
    await expect(
      dialog.getByText('Send crash reports to help improve the app', {
        exact: true,
      })
    ).toBeVisible()
  })

  test('crash reporting toggle can be enabled', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    const toggle = dialog.locator('#crash-reporting-toggle')
    await expect(toggle).not.toBeChecked()

    await toggle.click()

    // 应显示 success toast
    await expect(
      mockPage.getByText('Crash reporting enabled', { exact: true })
    ).toBeVisible({ timeout: 5000 })

    // Toggle 现在应处于选中状态
    await expect(toggle).toBeChecked()
  })

  test('crash reporting toggle can be disabled after enabling', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    const toggle = dialog.locator('#crash-reporting-toggle')

    // 先启用
    await toggle.click()
    await expect(toggle).toBeChecked()

    // 禁用
    await toggle.click()

    // 应显示 info toast
    await expect(
      mockPage.getByText('Crash reporting disabled', { exact: true })
    ).toBeVisible({ timeout: 5000 })

    await expect(toggle).not.toBeChecked()
  })

  test('API Configuration form shows all fields', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    await expect(
      dialog.getByText('API Endpoint', { exact: true })
    ).toBeVisible()
    await expect(dialog.getByText('API Key', { exact: true })).toBeVisible()
    await expect(
      dialog.getByText('Timeout (seconds)', { exact: true })
    ).toBeVisible()
    await expect(dialog.getByText('Retry Count', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Debug Mode', { exact: true })).toBeVisible()
  })

  test('API config form validation: invalid endpoint shows error', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    // 输入无效 endpoint（非 URL）
    await dialog.getByPlaceholder('https://api.example.com').fill('not-a-url')

    // 表单使用 onSubmit 模式 — 提交以触发校验
    await dialog.getByRole('button', { name: 'Save Configuration' }).click()

    // 应出现校验错误
    await expect(
      dialog.getByText('Must be a valid URL', { exact: true })
    ).toBeVisible()
  })

  test('API config form validation: short API key shows error', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    await dialog.getByPlaceholder('Enter your API key').fill('short')

    // 表单使用 onSubmit 模式 — 提交以触发校验
    await dialog.getByRole('button', { name: 'Save Configuration' }).click()

    await expect(
      dialog.getByText('API key must be at least 10 characters', {
        exact: true,
      })
    ).toBeVisible()
  })

  test('API config form submit with valid data shows success toast', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)
    await dialog.getByRole('button', { name: /^advanced$/i }).click()

    // 填写有效数据
    await dialog
      .getByPlaceholder('https://api.example.com')
      .fill('https://api.example.com')
    await dialog
      .getByPlaceholder('Enter your API key')
      .fill('valid-api-key-12345')

    // 提交表单
    await dialog.getByRole('button', { name: 'Save Configuration' }).click()

    // 等待 success toast（表单模拟异步保存，延迟 800ms）
    await expect(
      mockPage.getByText('API configuration saved successfully', {
        exact: true,
      })
    ).toBeVisible({ timeout: 5000 })
  })
})
