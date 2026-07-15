import { test, expect } from './fixtures'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

test.describe('Global Keyboard Shortcuts', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/')
    // 等待应用主界面加载完成（会话侧栏可见即代表应用已就绪）
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({ timeout: 15000 })
  })

  test('Ctrl+, opens the Preferences dialog', async ({ mockPage }) => {
    await expect(
      mockPage.getByRole('dialog', { name: /设置/i })
    ).toBeHidden()

    await mockPage.keyboard.press(`${modifierKey}+,`)

    await expect(
      mockPage.getByRole('dialog', { name: /设置/i })
    ).toBeVisible()
  })

  test('Ctrl+1 toggles the left sidebar visibility', async ({ mockPage }) => {
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()

    // sidebar 默认可见
    await expect(leftSidebar).toBeVisible()

    // 按 Ctrl+1 隐藏
    await mockPage.keyboard.press(`${modifierKey}+1`)
    await expect(leftSidebar).toBeHidden()

    // 再次按 Ctrl+1 显示
    await mockPage.keyboard.press(`${modifierKey}+1`)
    await expect(leftSidebar).toBeVisible()
  })

  test('Ctrl+2 toggles the right sidebar visibility', async ({ mockPage }) => {
    const rightSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .last()

    // sidebar 默认可见
    await expect(rightSidebar).toBeVisible()

    // 按 Ctrl+2 隐藏
    await mockPage.keyboard.press(`${modifierKey}+2`)
    await expect(rightSidebar).toBeHidden()

    // 再次按 Ctrl+2 显示
    await mockPage.keyboard.press(`${modifierKey}+2`)
    await expect(rightSidebar).toBeVisible()
  })

  test('shortcuts work independently — Ctrl+1 does not affect right sidebar', async ({
    mockPage,
  }) => {
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()
    const rightSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .last()

    // 两个 sidebar 默认都可见
    await expect(leftSidebar).toBeVisible()
    await expect(rightSidebar).toBeVisible()

    // 仅切换左侧 sidebar
    await mockPage.keyboard.press(`${modifierKey}+1`)
    await expect(leftSidebar).toBeHidden()
    await expect(rightSidebar).toBeVisible()
  })

  test('shortcuts work independently — Ctrl+2 does not affect left sidebar', async ({
    mockPage,
  }) => {
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()
    const rightSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .last()

    // 两个 sidebar 默认都可见
    await expect(leftSidebar).toBeVisible()
    await expect(rightSidebar).toBeVisible()

    // 仅切换右侧 sidebar
    await mockPage.keyboard.press(`${modifierKey}+2`)
    await expect(rightSidebar).toBeHidden()
    await expect(leftSidebar).toBeVisible()
  })

  test('pressing "1" without modifier key does not toggle sidebar', async ({
    mockPage,
  }) => {
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()

    await expect(leftSidebar).toBeVisible()

    // 不按 Ctrl/Meta 单独按 "1" — 不应切换
    await mockPage.keyboard.press('1')
    await expect(leftSidebar).toBeVisible()
  })

  test('Ctrl+, and Ctrl+K can be used in sequence', async ({ mockPage }) => {
    // 用 Ctrl+, 打开 preferences
    await mockPage.keyboard.press(`${modifierKey}+,`)
    await expect(
      mockPage.getByRole('dialog', { name: /设置/i })
    ).toBeVisible()

    // 用 Escape 关闭 preferences
    await mockPage.keyboard.press('Escape')
    await expect(
      mockPage.getByRole('dialog', { name: /设置/i })
    ).toBeHidden()

    // 用 Ctrl+K 打开 command palette
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeVisible()
  })
})
