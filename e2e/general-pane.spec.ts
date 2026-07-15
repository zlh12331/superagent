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

// 旧测试针对 Tauri 模板的 GeneralPane（Keyboard Shortcuts / System / Example Settings）。
// 新 UI 的 GeneralSettingsPane（SettingsPanes.tsx）功能完全不同（语言 / 显示密度 / 行为设置），
// 旧功能在新 UI 中不存在。新 UI 的通用分区测试由 codex-extended.spec.ts test 8 覆盖。
test.describe.skip('General Preferences Pane (legacy — 新 UI 已重构)', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
    })
  })

  test('shows Keyboard Shortcuts section with quick pane shortcut', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    // General 是默认激活的 pane
    await expect(
      dialog.getByRole('heading', { name: 'Keyboard Shortcuts' })
    ).toBeVisible()
    await expect(
      dialog.getByText('Quick Pane Shortcut', { exact: true })
    ).toBeVisible()
    await expect(
      dialog.getByText(
        'Global keyboard shortcut to toggle the quick pane from any application',
        { exact: true }
      )
    ).toBeVisible()
  })

  test('shows System section with launch at startup toggle', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    await expect(dialog.getByRole('heading', { name: 'System' })).toBeVisible()
    await expect(
      dialog.getByText('Launch at Startup', { exact: true })
    ).toBeVisible()
  })

  test('shows Example Settings section with text input and toggle', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    await expect(
      dialog.getByRole('heading', { name: 'Example Settings' })
    ).toBeVisible()
    await expect(
      dialog.getByText('Example Text Setting', { exact: true })
    ).toBeVisible()
    await expect(
      dialog.getByText('Example Toggle Setting', { exact: true })
    ).toBeVisible()
  })

  test('example text input accepts user input', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    const textInput = dialog.getByPlaceholder('Enter example text')
    await expect(textInput).toBeVisible()

    await textInput.fill('Test value 123')
    await expect(textInput).toHaveValue('Test value 123')
  })

  test('example toggle switches between Enabled and Disabled', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    // toggle 默认启用（标签显示 "Enabled"）
    await expect(dialog.locator('#example-toggle')).toBeChecked()

    // 点击禁用
    await dialog.locator('#example-toggle').click()
    await expect(dialog.locator('#example-toggle')).not.toBeChecked()

    // 点击重新启用
    await dialog.locator('#example-toggle').click()
    await expect(dialog.locator('#example-toggle')).toBeChecked()
  })

  test('autostart toggle is visible and toggleable', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    // Switch 组件将 id prop 转发给底层 button
    const autostartSwitch = dialog.locator('#autostart-toggle')
    await expect(autostartSwitch).toBeVisible()

    // mock 返回 false，故 autostart 默认未选中
    await expect(autostartSwitch).not.toBeChecked()

    // 点击启用
    await autostartSwitch.click()
    await expect(autostartSwitch).toBeChecked()
  })

  test('shortcut picker is visible with default value', async ({
    mockPage,
  }) => {
    const dialog = await openPreferences(mockPage)

    // 快捷键选择按钮显示当前快捷键。
    // Windows 显示 "Ctrl+Shift+."，macOS 显示 "⌘⇧."
    const shortcutButton = dialog.getByRole('button', {
      name: /ctrl|⌘|command/i,
    })
    await expect(shortcutButton).toBeVisible()
  })
})
