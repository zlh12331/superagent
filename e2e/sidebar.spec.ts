import { test, expect } from './fixtures'

test.describe('Sidebar toggle', () => {
  test.beforeEach(async ({ mockPage }) => {
    await mockPage.goto('http://localhost:1420/')
  })

  test('left sidebar toggles visible/hidden when clicking the left sidebar toggle button', async ({
    mockPage,
  }) => {
    // 标题栏按钮通过 `title` 属性识别。
    // 标题在 "Show" 和 "Hide" 之间切换，取决于 sidebar 状态。
    const leftSidebarToggle = mockPage.locator(
      'button[title="Show Left Sidebar"], button[title="Hide Left Sidebar"]'
    )
    // sidebar 渲染为可调整大小的 panel。第一个 panel 是左侧 sidebar。
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()

    // sidebar 默认可见
    await expect(leftSidebar).toBeVisible()

    // 点击 toggle 隐藏 sidebar
    await leftSidebarToggle.click()
    await expect(leftSidebar).toBeHidden()

    // 再次点击 toggle 显示 sidebar
    await leftSidebarToggle.click()
    await expect(leftSidebar).toBeVisible()
  })

  test('right sidebar toggles visible/hidden when clicking the right sidebar toggle button', async ({
    mockPage,
  }) => {
    const rightSidebarToggle = mockPage.locator(
      'button[title="Show Right Sidebar"], button[title="Hide Right Sidebar"]'
    )
    // 最后一个 panel 是右侧 sidebar。
    const rightSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .last()

    // sidebar 默认可见
    await expect(rightSidebar).toBeVisible()

    // 点击 toggle 隐藏 sidebar
    await rightSidebarToggle.click()
    await expect(rightSidebar).toBeHidden()

    // 再次点击 toggle 显示 sidebar
    await rightSidebarToggle.click()
    await expect(rightSidebar).toBeVisible()
  })

  test('both sidebars can be open simultaneously', async ({ mockPage }) => {
    const leftSidebarToggle = mockPage.locator(
      'button[title="Show Left Sidebar"], button[title="Hide Left Sidebar"]'
    )
    const rightSidebarToggle = mockPage.locator(
      'button[title="Show Right Sidebar"], button[title="Hide Right Sidebar"]'
    )
    const leftSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .first()
    const rightSidebar = mockPage
      .locator('[data-slot="resizable-panel"]')
      .last()

    // 确保两个 sidebar 都可见，仅在必要时切换
    if (await leftSidebar.isHidden()) {
      await leftSidebarToggle.click()
    }
    if (await rightSidebar.isHidden()) {
      await rightSidebarToggle.click()
    }

    // 两个 sidebar 同时可见
    await expect(leftSidebar).toBeVisible()
    await expect(rightSidebar).toBeVisible()
  })
})
