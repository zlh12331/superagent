// e2e/journey-terminal.spec.ts：终端旅程 E2E——Ctrl+` 唤出终端视图 → 自动建终端 → xterm 挂载 → 键盘输入
// 环境：浏览器模式（vite.web.config.ts + dev mock window.api，PTY 输出/回显均为 mock）
// 入口：DevPanel 是动态 tab 制（默认仅 info 常驻），「终端」tab 由 Ctrl+` 快捷键加入并激活
import { expect, test } from '@playwright/test';

test.describe('终端用户旅程（batch 3）', () => {
  // 预热：vite 冷启动首屏编译慢，先访问一次触发编译，后续用例首屏才稳定
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程5：Ctrl+` 打开终端 → 新建终端 → xterm 渲染', async ({ page }) => {
    await page.goto('/');

    // 会话标题取自 dev mock 预置数据（src/renderer/dev/mock-api.ts），改 mock 需同步此正则
    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.waitForTimeout(500);

    // Ctrl+`：展开右面板并把 devPanelTab 切到 terminal，该 tab 随即被 DevPanel 加入 tab 列表
    await page.keyboard.press('Control+`');

    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();

    // 进入终端视图即自动创建终端（会话下无终端时 TerminalPanel 直接建，界面无「新建终端」按钮）；
    // 此处只断言 xterm 已挂载——PTY 输出/文本语义由 tests/integration/terminal.test.ts 覆盖
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('旅程5：终端面板可交互（新建 + 输入区存在）', async ({ page }) => {
    await page.goto('/');

    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.waitForTimeout(500);

    await page.keyboard.press('Control+`');

    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();

    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // 输入区 = xterm 的隐藏 textarea，键盘事件入口（随光标定位的透明代理）
    const termInput = page.locator('.xterm-helper-textarea, .xterm textarea').first();
    await expect(termInput).toBeVisible({ timeout: 10_000 });
    // 点终端可视区（真实用户路径）而非直接点 textarea：后者透明度 0、z-index 为负，直接点命中不稳定
    await page.locator('.xterm-screen, .xterm').first().click();
    // 点完焦点必须落到 textarea——xterm 只在该 textarea 聚焦时接收键入
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
        ),
      )
      .toBe(true);
    await termInput.pressSequentially('echo hello');
    await termInput.press('Enter');
    await page.waitForTimeout(500);
    // 输入后终端面板仍在：防输入链路崩溃/卸载，不作内容断言
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible();
  });
});
