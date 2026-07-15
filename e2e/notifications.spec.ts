import { test, expect } from './fixtures'

const isMacOS = process.platform === 'darwin'
const modifierKey = isMacOS ? 'Meta' : 'Control'

test.describe('Notification System', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/')
    // 等待应用主界面加载完成（会话侧栏可见即代表应用已就绪）
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({ timeout: 15000 })
  })

  test('Test Toast command appears in command palette', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search|command/i)
    await searchInput.fill('toast')

    await expect(
      mockPage.getByRole('option', { name: /test toast/i })
    ).toBeVisible()
  })

  test('executing Test Toast shows a success toast notification', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search|command/i)
    await searchInput.fill('toast')

    await mockPage.keyboard.press('Enter')

    // toast 应显示测试通知文本
    await expect(mockPage.getByText(/test notification sent/i)).toBeVisible({
      timeout: 5000,
    })
  })

  test('toast notification includes the description text', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search|command/i)
    await searchInput.fill('toast')
    await mockPage.keyboard.press('Enter')

    // toast 合并标题和描述
    await expect(
      mockPage.getByText(/check your system notifications/i)
    ).toBeVisible({ timeout: 5000 })
  })

  test('command palette closes after executing Test Toast', async ({
    mockPage,
  }) => {
    await mockPage.keyboard.press(`${modifierKey}+k`)

    const searchInput = mockPage.getByPlaceholder(/search|command/i)
    await searchInput.fill('toast')
    await mockPage.keyboard.press('Enter')

    await expect(
      mockPage.getByRole('dialog', { name: /command palette/i })
    ).toBeHidden()
  })

  test('multiple toasts can be triggered in succession', async ({
    mockPage,
  }) => {
    // 第一个 toast
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await mockPage.getByPlaceholder(/search|command/i).fill('toast')
    await mockPage.keyboard.press('Enter')
    await expect(
      mockPage.getByText(/test notification sent/i).first()
    ).toBeVisible({ timeout: 5000 })

    // 第二个 toast
    await mockPage.keyboard.press(`${modifierKey}+k`)
    await mockPage.getByPlaceholder(/search|command/i).fill('toast')
    await mockPage.keyboard.press('Enter')
    await expect(
      mockPage.getByText(/test notification sent/i).first()
    ).toBeVisible({ timeout: 5000 })
  })
})
