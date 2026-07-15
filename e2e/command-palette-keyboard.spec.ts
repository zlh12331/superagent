import { test, expect } from './fixtures'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

test.describe('Command Palette Keyboard Navigation', () => {
  // 为 Vite dev server 冷启动预留额外时间
  test.setTimeout(60000)

  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
    })
    // 等待应用主界面加载完成（会话侧栏可见即代表应用已就绪）
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({ timeout: 15000 })
  })

  test('Escape closes the command palette', async ({ mockPage }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    await mockPage.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('Ctrl+K toggles command palette open and closed', async ({
    mockPage,
  }) => {
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })

    // 打开
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await expect(dialog).toBeVisible()

    // 用相同快捷键关闭
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await expect(dialog).toBeHidden()
  })

  test('Arrow Down moves selection to the next command', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    // 第一个命令默认应视觉上处于激活/选中状态。
    // 按 Arrow Down 移动到下一个命令。
    await mockPage.keyboard.press('ArrowDown')

    // 导航后，按 Enter 执行高亮的命令。
    // 验证 command palette 关闭（命令已执行）。
    await mockPage.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
  })

  test('Arrow Up moves selection to the previous command', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    // 先向下移动，再回到原位
    await mockPage.keyboard.press('ArrowDown')
    await mockPage.keyboard.press('ArrowUp')

    // 在原来的第一个命令上按 Enter
    await mockPage.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
  })

  test('clearing search restores full command list', async ({ mockPage }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    const searchInput = dialog.getByPlaceholder(/search/i)

    // 输入不匹配的查询
    await searchInput.fill('zzzznonexistent')
    await expect(mockPage.getByText(/no results found/i)).toBeVisible()

    // 清空搜索 — 命令应重新出现
    await searchInput.clear()
    await expect(mockPage.getByText(/no results found/i)).toBeHidden()
    // 部分命令文本应再次可见
    await expect(
      mockPage.getByText(/sidebar|preferences|window/i).first()
    ).toBeVisible()
  })

  test('Backspace to empty search restores full list', async ({ mockPage }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    const searchInput = dialog.getByPlaceholder(/search/i)
    await searchInput.fill('xyz')
    await expect(mockPage.getByText(/no results found/i)).toBeVisible()

    // 按 Backspace 清空
    await searchInput.press('Backspace')
    await searchInput.press('Backspace')
    await searchInput.press('Backspace')

    await expect(mockPage.getByText(/no results found/i)).toBeHidden()
  })

  test('command palette search is case-insensitive', async ({ mockPage }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)
    const dialog = mockPage.getByRole('dialog', { name: /command palette/i })
    await expect(dialog).toBeVisible()

    const searchInput = dialog.getByPlaceholder(/search/i)

    // 用大写搜索
    await searchInput.fill('PREFERENCES')
    await expect(mockPage.getByText(/open preferences/i)).toBeVisible()

    // 用大小写混合搜索
    await searchInput.fill('PrEfErEnCeS')
    await expect(mockPage.getByText(/open preferences/i)).toBeVisible()
  })
})
