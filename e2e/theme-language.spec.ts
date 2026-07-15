import { test, expect } from './fixtures'
import type { Page, Locator } from '@playwright/test'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

// 旧测试针对 Tauri 模板的 AppearancePane（Select combobox + "Choose your preferred color theme"）。
// 新 UI 的 AppearanceSettingsPane（SettingsPanes.tsx）使用 SegControl（暗色 / 浅色 / 跟随系统），
// 没有 combobox 和英文描述文本。新 UI 的主题切换测试由 codex-extended.spec.ts test 11 覆盖。
test.describe.skip('Theme and Language Settings (legacy — 新 UI 已重构)', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
    })
  })

  /**
   * Opens the Preferences dialog via the command palette (Ctrl+K on
   * Windows/Linux, Meta+K on macOS).
   *
   * The title-bar settings button exposes its label through the `title`
   * attribute rather than `aria-label`, which makes role-based lookup
   * unreliable. Opening through the command palette is consistently stable.
   *
   * Returns a locator scoped to the Preferences dialog for further assertions.
   */
  async function openPreferences(page: Page): Promise<Locator> {
    // 等待应用主界面加载完成（会话侧栏可见即代表应用已就绪）
    await expect(
      page.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({ timeout: 15000 })
    await page.keyboard.press(`${modifierKey}+k`)

    const commandDialog = page.getByRole('dialog', { name: /command palette/i })
    await expect(commandDialog).toBeVisible()
    await commandDialog.getByPlaceholder(/command|search/i).fill('preferences')
    await page.keyboard.press('Enter')

    // 设置对话框的 accessible name 为 "设置"（重构后中文 UI）
    const dialog = page.getByRole('dialog', { name: /设置/i })
    await expect(dialog).toBeVisible()
    return dialog
  }

  /**
   * Locates the theme combobox within the Appearance pane.
   *
   * The Appearance pane renders two shadcn Select components (language and
   * theme). The theme field is identified by its unique description text,
   * then the combobox (SelectTrigger) within that field is returned.
   */
  function themeCombobox(dialog: Locator): Locator {
    return dialog
      .getByText('Choose your preferred color theme', { exact: true })
      .locator('xpath=..')
      .getByRole('combobox')
  }

  /**
   * Locates the language combobox within the Appearance pane.
   */
  function languageCombobox(dialog: Locator): Locator {
    return dialog
      .getByText('Choose your preferred display language', { exact: true })
      .locator('xpath=..')
      .getByRole('combobox')
  }

  test('Appearance tab shows theme selection', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    // 通过 sidebar 导航按钮切换到 Appearance pane。
    await dialog.getByRole('button', { name: /^appearance$/i }).click()

    // 验证 theme combobox（shadcn Select trigger）可见。
    await expect(themeCombobox(dialog)).toBeVisible()
  })

  test('Selecting Dark theme applies dark theme', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    await dialog.getByRole('button', { name: /^appearance$/i }).click()

    // 打开 theme 下拉框并选择 Dark。选项渲染在
    // document body 层级的 portaled popover 中。
    await themeCombobox(dialog).click()
    await mockPage.getByRole('option', { name: 'Dark' }).click()

    // 验证 document 元素接收 dark theme class。
    const className = await mockPage.evaluate(
      () => document.documentElement.className
    )
    expect(className).toContain('dark')
  })

  test('Selecting Light theme reverts', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    await dialog.getByRole('button', { name: /^appearance$/i }).click()

    // 先应用 Dark，再切回 Light。
    await themeCombobox(dialog).click()
    await mockPage.getByRole('option', { name: 'Dark' }).click()

    await themeCombobox(dialog).click()
    await mockPage.getByRole('option', { name: 'Light' }).click()

    // 验证 document 元素已移除 dark class。
    const className = await mockPage.evaluate(
      () => document.documentElement.className
    )
    expect(className).not.toContain('dark')
  })

  test('Language selection dropdown is visible', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    await dialog.getByRole('button', { name: /^appearance$/i }).click()

    // 验证 language combobox（shadcn Select trigger）可见。
    await expect(languageCombobox(dialog)).toBeVisible()
  })

  test('Selecting Chinese updates UI text', async ({ mockPage }) => {
    const dialog = await openPreferences(mockPage)

    await dialog.getByRole('button', { name: /^appearance$/i }).click()

    // 打开 language 下拉框并选择 Chinese。选项标签使用
    // 原生名称 "中文"。
    await languageCombobox(dialog).click()
    await mockPage.getByRole('option', { name: /中文|chinese/i }).click()

    // i18n 使用懒加载 — 中文 locale chunk 通过
    // dynamic import() 在选择后获取。languageChanged 事件会立即设置
    // document.documentElement.lang，这是语言切换生效的
    // 可靠指标。
    await expect(mockPage.locator('html')).toHaveAttribute('lang', 'zh', {
      timeout: 10000,
    })

    // 验证 UI 文本已更新为中文，通过检查
    // breadcrumb 头部现在显示 "偏好设置"。
    await expect(
      mockPage
        .getByRole('navigation', { name: /breadcrumb/i })
        .getByText('偏好设置', { exact: true })
    ).toBeVisible({ timeout: 15000 })
  })
})
