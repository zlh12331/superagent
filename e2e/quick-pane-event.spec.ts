import { test, expect } from './fixtures'

test.describe('Quick Pane Event Communication', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/')
    // 等待应用主界面加载完成（会话侧栏可见即代表应用已就绪）
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible({
      timeout: 15000,
    })
    // 等待事件监听器注册
    await expect
      .poll(
        async () =>
          mockPage.evaluate(() => window.__testHelpers.getRegisteredChannels()),
        { timeout: 10000, intervals: [500] }
      )
      .toContain('quick-pane-submit')
  })

  test('主窗口默认渲染会话侧栏', async ({ mockPage }) => {
    // 新 UI 已移除旧版默认标题，改为验证会话侧栏默认可见。
    // 侧栏是应用主界面的核心组成，其可见即代表主窗口已正确渲染。
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible()
  })

  // 以下测试用例验证 quick-pane-submit 事件对主窗口可见内容的影响。
  // 重构后 quick-pane-submit 事件仅更新 useUIStore 的 lastQuickPaneEntry 状态，
  // 不再渲染到主窗口的可见 DOM 元素（旧的 "Last entry: ..." heading 已移除）。
  // 由于 useUIStore 未通过 window 暴露给 E2E 测试访问，且新 UI 无对应的可见元素，
  // 这些测试用例暂时跳过。如需验证 store 状态更新，应在单元测试中覆盖
  // （见 src/hooks/useMainWindowEventListeners.test.ts）。
  test.skip('quick-pane-submit 事件更新主窗口内容', async ({ mockPage }) => {
    await mockPage.evaluate(() => {
      window.__testHelpers.emitEvent('quick-pane-submit', {
        text: 'Test entry',
      })
    })

    await expect(
      mockPage.getByRole('heading', { name: /last entry: test entry/i })
    ).toBeVisible({ timeout: 5000 })
  })

  test.skip('多个 quick-pane-submit 事件顺序更新内容', async ({ mockPage }) => {
    // 第一个 entry
    await mockPage.evaluate(() => {
      window.__testHelpers.emitEvent('quick-pane-submit', {
        text: 'First entry',
      })
    })
    await expect(
      mockPage.getByRole('heading', { name: /last entry: first entry/i })
    ).toBeVisible({ timeout: 5000 })

    // 第二个 entry 覆盖第一个
    await mockPage.evaluate(() => {
      window.__testHelpers.emitEvent('quick-pane-submit', {
        text: 'Second entry',
      })
    })
    await expect(
      mockPage.getByRole('heading', { name: /last entry: second entry/i })
    ).toBeVisible({ timeout: 5000 })
  })

  test.skip('空文本的 quick-pane-submit 保留默认内容', async () => {
    // 重构后该事件仅更新 store 状态，不再有可见的默认内容区，
    // 因此"空文本保留默认内容"的断言已无对应 UI 元素，跳过。
    // store 层面的空字符串处理由单元测试覆盖
    // （见 src/store/ui-store.test.ts）。
  })

  test('无关事件不影响主窗口侧栏可见性', async ({ mockPage }) => {
    // 发射一个无关事件
    await mockPage.evaluate(() => {
      window.__testHelpers.emitEvent('some-other-event', { text: 'ignored' })
    })

    // 新 UI 已移除旧版默认标题，改为验证侧栏仍可见。
    // 无关事件不应影响主窗口的核心 UI 元素。
    await expect(
      mockPage.getByRole('complementary', { name: /会话侧栏/i })
    ).toBeVisible()
  })
})
