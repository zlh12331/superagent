/**
 * Codex Desktop 扩展功能 E2E 测试（Task 26）
 *
 * 验证终端面板、文件树、设置抽屉的完整交互流程：
 *
 * 终端面板：
 * 1. 打开终端面板 — 右侧栏可见，终端标签渲染，xterm 容器可见
 * 2. 新建终端会话 — 点击 + 按钮，验证新标签出现
 * 3. 关闭终端会话 — 点击 × 按钮，验证标签减少
 *
 * 文件树：
 * 4. 打开文件树 — 从线程项切换到文件树视图
 * 5. 展开目录 — 点击文件夹节点，验证子节点出现
 * 6. 模糊搜索 — 打开搜索对话框，输入关键词，验证结果
 * 7. 返回会话 — 点击返回按钮回到线程列表
 *
 * 设置抽屉：
 * 8. 打开设置 — Ctrl+, 打开，验证分区导航
 * 9. 切换分区 — 点击不同分区，验证内容切换
 * 10. 修改 API 配置 — 导航到 API 配置，修改模型选择
 * 11. 修改主题 — 导航到外观，切换主题
 *
 * 运行方式：在 Vite dev server 上执行，使用 tauri-mock 模拟 Tauri API。
 *
 * @see e2e/fixtures.ts — mockPage fixture（注入 tauri-mock）
 * @see e2e/mocks/tauri-mock.ts — Tauri API mock（含 Codex 命令 + command_exec）
 */

import { test, expect } from './fixtures'

// 测试统一的超时配置
const LOAD_TIMEOUT = 20_000
const NAV_TIMEOUT = 90_000

test.describe('Codex Extended Features', () => {
  test.beforeEach(async ({ mockPage }) => {
    test.setTimeout(NAV_TIMEOUT)
    // 每个 test 前重置 mock 线程列表
    await mockPage.addInitScript(() => {
      window.__testHelpers?.resetMockThreads()
    })
    await mockPage.goto('http://localhost:1420/', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    })
  })

  // ═════════════════════════════════════════════════════════════
  // 终端面板测试
  // ═════════════════════════════════════════════════════════════

  // ─── 1. 打开终端面板 ─────────────────────────────────────────
  test('1. 打开终端面板 — 右侧栏可见，终端标签渲染', async ({ mockPage }) => {
    // 右侧栏默认可见（sidebar-store rightSidebarVisible=true）
    // ContextPanel 默认激活 terminal tab
    // 验证终端 tab 按钮存在（id 包含 "terminal"）
    const terminalTab = mockPage.locator('button[role="tab"]#crp-tab-terminal')
    await expect(terminalTab).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 点击终端 tab 确保激活
    await terminalTab.click()

    // 终端面板应显示新建终端按钮（title="新建终端"）
    const newTerminalButton = mockPage.locator('button[title="新建终端"]')
    await expect(newTerminalButton).toBeVisible({ timeout: LOAD_TIMEOUT })

    // xterm 容器应渲染（xterm.js 自动生成 .xterm 根元素）
    const xtermContainer = mockPage.locator('.xterm').first()
    await expect(xtermContainer).toBeVisible({ timeout: LOAD_TIMEOUT })
  })

  // ─── 2. 新建终端会话 ─────────────────────────────────────────
  test('2. 新建终端会话 — 点击 + 按钮创建新标签', async ({ mockPage }) => {
    // 确保终端面板可见
    const terminalTab = mockPage.locator('button[role="tab"]#crp-tab-terminal')
    await expect(terminalTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await terminalTab.click()

    // 每个终端标签有一个关闭按钮（title="关闭终端"），
    // 通过计数关闭按钮来计数终端标签
    const closeButtons = mockPage.locator('button[title="关闭终端"]')
    const initialCount = await closeButtons.count()

    // 点击新建终端按钮
    const newTerminalButton = mockPage.locator('button[title="新建终端"]')
    await expect(newTerminalButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await newTerminalButton.click()

    // 验证终端标签数量增加
    await expect(async () => {
      const afterCount = await closeButtons.count()
      expect(afterCount).toBeGreaterThan(initialCount)
    }).toPass({ timeout: LOAD_TIMEOUT })

    // 验证 invoke 日志中包含 command_exec（终端会话启动调用）
    const invokeLog = await mockPage.evaluate(
      () => window.__testHelpers?.getInvokeLog() ?? []
    )
    expect(invokeLog).toContain('command_exec')
  })

  // ─── 3. 关闭终端会话 ─────────────────────────────────────────
  test('3. 关闭终端会话 — 点击 × 按钮关闭标签', async ({ mockPage }) => {
    // 确保终端面板可见
    const terminalTab = mockPage.locator('button[role="tab"]#crp-tab-terminal')
    await expect(terminalTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await terminalTab.click()

    // 新建一个终端会话以确保有 2 个标签（store 默认 1 个，closeSession 最少保持 1 个）
    const newTerminalButton = mockPage.locator('button[title="新建终端"]')
    await expect(newTerminalButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await newTerminalButton.click()

    // 等待新标签出现
    await expect(async () => {
      const tabs = mockPage.locator('button[title="关闭终端"]')
      const count = await tabs.count()
      expect(count).toBeGreaterThanOrEqual(2)
    }).toPass({ timeout: LOAD_TIMEOUT })

    // 记录关闭前的标签数量
    const closeButtons = mockPage.locator('button[title="关闭终端"]')
    const beforeCount = await closeButtons.count()

    // 点击第一个关闭按钮
    await closeButtons.first().click()

    // 验证标签数量减少
    await expect(async () => {
      const afterCount = await closeButtons.count()
      expect(afterCount).toBeLessThan(beforeCount)
    }).toPass({ timeout: LOAD_TIMEOUT })

    // 验证 invoke 日志中包含 command_exec_terminate（终端会话清理）
    // 注意：TerminalView 的 cleanup 异步调用 terminateTerminalSession，
    // 需要等待 cleanup 完成
    await expect(async () => {
      const log = await mockPage.evaluate(
        () => window.__testHelpers?.getInvokeLog() ?? []
      )
      expect(log).toContain('command_exec_terminate')
    }).toPass({ timeout: LOAD_TIMEOUT })
  })

  // ═════════════════════════════════════════════════════════════
  // 文件树测试
  // ═════════════════════════════════════════════════════════════

  // ─── 4. 打开文件树 ───────────────────────────────────────────
  test('4. 打开文件树 — 从线程项切换到文件树视图', async ({ mockPage }) => {
    // 先点击一个线程项使其 active（hover 按钮在 active 状态下可见）
    const threadItem = mockPage.locator('[role="group"][data-id]').first()
    await expect(threadItem).toBeVisible({ timeout: LOAD_TIMEOUT })
    await threadItem.click()

    // 等待线程变为 active，"查看目录" 按钮变为可见
    // 只匹配 active 线程的"查看目录"按钮（ThreadItem 的 hover actions div
    // 通过 data-active 属性标记 active 状态，避免多线程场景下的 strict mode violation）
    const showFilesButton = mockPage.locator(
      '[data-active="true"] button[aria-label="查看目录"]'
    )
    await expect(showFilesButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await showFilesButton.click()

    // 文件树视图应显示 — 验证"返回会话"按钮可见
    const backButton = mockPage.locator('button[aria-label="返回会话"]')
    await expect(backButton).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 验证文件树节点渲染（至少有 1 个 treeitem）
    const treeNodes = mockPage.locator('div[role="treeitem"]')
    await expect(treeNodes.first()).toBeVisible({ timeout: LOAD_TIMEOUT })
  })

  // ─── 5. 展开目录 ─────────────────────────────────────────────
  test('5. 展开目录 — 点击文件夹节点展开', async ({ mockPage }) => {
    // 切换到文件树视图
    const threadItem = mockPage.locator('[role="group"][data-id]').first()
    await expect(threadItem).toBeVisible({ timeout: LOAD_TIMEOUT })
    await threadItem.click()

    // 只匹配 active 线程的"查看目录"按钮（ThreadItem 的 hover actions div
    // 通过 data-active 属性标记 active 状态，避免多线程场景下的 strict mode violation）
    const showFilesButton = mockPage.locator(
      '[data-active="true"] button[aria-label="查看目录"]'
    )
    await expect(showFilesButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await showFilesButton.click()

    // 等待文件树渲染
    const treeNodes = mockPage.locator('div[role="treeitem"]')
    await expect(treeNodes.first()).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 记录展开前的节点数量
    const beforeCount = await treeNodes.count()

    // 查找折叠的文件夹节点（aria-expanded="false"）
    const collapsedFolder = mockPage.locator(
      'div[role="treeitem"][aria-expanded="false"]'
    )

    // 如果有折叠的文件夹，点击展开
    const folderCount = await collapsedFolder.count()
    if (folderCount > 0) {
      await collapsedFolder.first().click()

      // 验证节点数量增加（子节点出现）
      await expect(async () => {
        const afterCount = await treeNodes.count()
        expect(afterCount).toBeGreaterThan(beforeCount)
      }).toPass({ timeout: LOAD_TIMEOUT })
    } else {
      // 如果没有折叠的文件夹，查找已展开的文件夹并验证
      const expandedFolder = mockPage.locator(
        'div[role="treeitem"][aria-expanded="true"]'
      )
      await expect(expandedFolder.first()).toBeVisible({
        timeout: LOAD_TIMEOUT,
      })
    }
  })

  // ─── 6. 模糊搜索 ─────────────────────────────────────────────
  test('6. 模糊搜索 — 打开搜索对话框，输入关键词', async ({ mockPage }) => {
    // 切换到文件树视图
    const threadItem = mockPage.locator('[role="group"][data-id]').first()
    await expect(threadItem).toBeVisible({ timeout: LOAD_TIMEOUT })
    await threadItem.click()

    // 只匹配 active 线程的"查看目录"按钮（ThreadItem 的 hover actions div
    // 通过 data-active 属性标记 active 状态，避免多线程场景下的 strict mode violation）
    const showFilesButton = mockPage.locator(
      '[data-active="true"] button[aria-label="查看目录"]'
    )
    await expect(showFilesButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await showFilesButton.click()

    // 等待文件树渲染
    const treeNodes = mockPage.locator('div[role="treeitem"]')
    await expect(treeNodes.first()).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 点击搜索按钮打开模糊搜索对话框
    const searchButton = mockPage.locator('button[aria-label="搜索文件"]')
    await expect(searchButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await searchButton.click()

    // 搜索对话框应可见（Radix Dialog，标题为 "文件搜索"）
    const searchDialog = mockPage.getByRole('dialog', { name: /文件搜索/i })
    await expect(searchDialog).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 搜索输入框应可见
    const searchInput = searchDialog.locator('input[aria-label="搜索文件"]')
    await expect(searchInput).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 输入搜索关键词（mock 数据中应包含 ".rs" 或 ".ts" 文件）
    await searchInput.fill('.rs')

    // 等待防抖（200ms）后验证搜索结果出现
    // 搜索结果项使用 role="option"
    const resultItems = searchDialog.locator('[role="option"]')
    await expect(resultItems.first()).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 关闭搜索对话框
    await mockPage.keyboard.press('Escape')
    await expect(searchDialog).toBeHidden({ timeout: LOAD_TIMEOUT })
  })

  // ─── 7. 返回会话 ─────────────────────────────────────────────
  test('7. 返回会话 — 点击返回按钮回到线程列表', async ({ mockPage }) => {
    // 切换到文件树视图
    const threadItem = mockPage.locator('[role="group"][data-id]').first()
    await expect(threadItem).toBeVisible({ timeout: LOAD_TIMEOUT })
    await threadItem.click()

    // 只匹配 active 线程的"查看目录"按钮（ThreadItem 的 hover actions div
    // 通过 data-active 属性标记 active 状态，避免多线程场景下的 strict mode violation）
    const showFilesButton = mockPage.locator(
      '[data-active="true"] button[aria-label="查看目录"]'
    )
    await expect(showFilesButton).toBeVisible({ timeout: LOAD_TIMEOUT })
    await showFilesButton.click()

    // 验证文件树视图已激活
    const backButton = mockPage.locator('button[aria-label="返回会话"]')
    await expect(backButton).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 点击返回按钮
    await backButton.click()

    // 验证回到线程列表 — "新建会话" 按钮应重新可见
    const newThreadButton = mockPage.getByRole('button', { name: /新建会话/i })
    await expect(newThreadButton).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 验证文件树的"返回会话"按钮已消失
    await expect(backButton).toBeHidden({ timeout: LOAD_TIMEOUT })
  })

  // ═════════════════════════════════════════════════════════════
  // 设置抽屉测试
  // ═════════════════════════════════════════════════════════════

  // ─── 8. 打开设置 ─────────────────────────────────────────────
  test('8. 打开设置 — Ctrl+, 打开，验证分区导航', async ({ mockPage }) => {
    // 按 Ctrl+, 打开设置抽屉
    await mockPage.keyboard.press('Control+,')

    // 设置抽屉应可见（Sheet 组件，SheetTitle 为 sr-only "设置"）
    const settingsDialog = mockPage.getByRole('dialog', { name: /设置/i })
    await expect(settingsDialog).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 分区导航应可见
    const nav = settingsDialog.locator(
      'nav[role="tablist"][aria-label="设置分区"]'
    )
    await expect(nav).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 应有多个分区导航项（通用、外观、API 配置、编辑器、快捷键、MCP 服务器、高级、账户、关于）
    const navItems = nav.locator('button[role="tab"]')
    const navCount = await navItems.count()
    expect(navCount).toBeGreaterThanOrEqual(5)

    // 默认应激活"通用"分区
    const activeTab = nav.locator('button[role="tab"][aria-selected="true"]')
    await expect(activeTab).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 关闭设置
    await mockPage.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden({ timeout: LOAD_TIMEOUT })
  })

  // ─── 9. 切换分区 ─────────────────────────────────────────────
  test('9. 切换分区 — 点击不同分区，验证内容切换', async ({ mockPage }) => {
    // 打开设置
    await mockPage.keyboard.press('Control+,')
    const settingsDialog = mockPage.getByRole('dialog', { name: /设置/i })
    await expect(settingsDialog).toBeVisible({ timeout: LOAD_TIMEOUT })

    const nav = settingsDialog.locator(
      'nav[role="tablist"][aria-label="设置分区"]'
    )
    const navItems = nav.locator('button[role="tab"]')

    // 点击"外观"分区
    const appearanceTab = navItems.filter({ hasText: '外观' })
    await expect(appearanceTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await appearanceTab.click()

    // 验证"外观"分区已激活
    await expect(appearanceTab).toHaveAttribute('aria-selected', 'true', {
      timeout: LOAD_TIMEOUT,
    })

    // 点击"高级"分区
    const advancedTab = navItems.filter({ hasText: '高级' })
    await expect(advancedTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await advancedTab.click()

    // 验证"高级"分区已激活，"外观"分区取消激活
    await expect(advancedTab).toHaveAttribute('aria-selected', 'true', {
      timeout: LOAD_TIMEOUT,
    })
    await expect(appearanceTab).toHaveAttribute('aria-selected', 'false', {
      timeout: LOAD_TIMEOUT,
    })

    // 关闭设置
    await mockPage.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden({ timeout: LOAD_TIMEOUT })
  })

  // ─── 10. 修改 API 配置 ───────────────────────────────────────
  test('10. 修改 API 配置 — 导航到 API 配置，修改模型选择', async ({
    mockPage,
  }) => {
    // 打开设置
    await mockPage.keyboard.press('Control+,')
    const settingsDialog = mockPage.getByRole('dialog', { name: /设置/i })
    await expect(settingsDialog).toBeVisible({ timeout: LOAD_TIMEOUT })

    const nav = settingsDialog.locator(
      'nav[role="tablist"][aria-label="设置分区"]'
    )
    const navItems = nav.locator('button[role="tab"]')

    // 点击"API 配置"分区
    const apiConfigTab = navItems.filter({ hasText: /API/i })
    await expect(apiConfigTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await apiConfigTab.click()

    // 验证 API 配置分区已激活
    await expect(apiConfigTab).toHaveAttribute('aria-selected', 'true', {
      timeout: LOAD_TIMEOUT,
    })

    // 查找模型选择下拉框（SettingsPanes.tsx 的 ApiConfigSettingsPane）
    // 当前实现使用 <select> 元素，包含 gpt-5/gpt-5-mini/deepseek-v4/claude-sonnet-4
    const modelSelect = settingsDialog.locator('select').first()
    await expect(modelSelect).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 记录修改前的值
    const beforeValue = await modelSelect.inputValue()

    // 修改模型选择（选择第二个选项）
    const options = modelSelect.locator('option')
    const optionCount = await options.count()
    expect(optionCount).toBeGreaterThanOrEqual(2)

    // 选择一个不同于当前的选项
    const targetOption = await options.nth(1).getAttribute('value')
    if (targetOption && targetOption !== beforeValue) {
      await modelSelect.selectOption(targetOption)
    } else {
      // 如果第二个和当前相同，选第三个
      const altOption = await options
        .nth(Math.min(2, optionCount - 1))
        .getAttribute('value')
      if (altOption) {
        await modelSelect.selectOption(altOption)
      }
    }

    // 验证选择值已更新
    const afterValue = await modelSelect.inputValue()
    expect(afterValue).not.toBe(beforeValue)

    // 关闭设置
    await mockPage.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden({ timeout: LOAD_TIMEOUT })
  })

  // ─── 11. 修改主题 ────────────────────────────────────────────
  test('11. 修改主题 — 导航到外观，切换主题', async ({ mockPage }) => {
    // 打开设置
    await mockPage.keyboard.press('Control+,')
    const settingsDialog = mockPage.getByRole('dialog', { name: /设置/i })
    await expect(settingsDialog).toBeVisible({ timeout: LOAD_TIMEOUT })

    const nav = settingsDialog.locator(
      'nav[role="tablist"][aria-label="设置分区"]'
    )
    const navItems = nav.locator('button[role="tab"]')

    // 点击"外观"分区
    const appearanceTab = navItems.filter({ hasText: '外观' })
    await expect(appearanceTab).toBeVisible({ timeout: LOAD_TIMEOUT })
    await appearanceTab.click()

    // 查找主题切换按钮（SegControl 渲染为 button，文本为 暗色/浅色/跟随系统）
    const lightThemeButton = settingsDialog.getByRole('button', {
      name: '浅色',
    })
    await expect(lightThemeButton).toBeVisible({ timeout: LOAD_TIMEOUT })

    // 点击"浅色"主题
    await lightThemeButton.click()

    // 验证主题已应用到 HTML 根元素
    // applyThemeClass 会在 documentElement 上添加 class（如 "light" 或 "dark"）
    const htmlClass = await mockPage.evaluate(
      () => document.documentElement.className
    )
    // 应包含 "light" 相关的 class
    expect(htmlClass.toLowerCase()).toContain('light')

    // 关闭设置
    await mockPage.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden({ timeout: LOAD_TIMEOUT })
  })
})
