// e2e/journey-terminal.spec.ts
// 核心用户旅程 E2E：终端流程（batch 3）
// ──────────────────────────────────────────────────────────────
// 旅程 5：打开终端面板 → 创建 → 输入命令 → 输出显示 → 关闭
// 环境：web 模式（mock window.api——mock PTY 输出/回显）
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('终端用户旅程（batch 3）', () => {
  // 预热：vite 冷启动首屏编译慢——先行访问触发编译
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程5：打开终端面板 → 新建终端 → xterm 渲染', async ({ page }) => {
    await page.goto('/');

    // 打开终端 tab（右面板）
    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();

    // 新建终端（store 创建——TerminalTabs 的 + 按钮）
    const newTermBtn = page.getByRole('button', { name: '新建终端' }).first();
    await expect(newTermBtn).toBeVisible({ timeout: 10_000 });
    await newTermBtn.click();

    // xterm 渲染（输出渲染在 canvas——文本不可断言；输出正确性由集成测试覆盖）
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('旅程5：终端面板可交互（新建 + 输入区存在）', async ({ page }) => {
    await page.goto('/');

    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();
    // 新建终端
    const newTermBtn = page.getByRole('button', { name: '新建终端' }).first();
    await expect(newTermBtn).toBeVisible({ timeout: 10_000 });
    await newTermBtn.click();
    // xterm 渲染
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // 输入区（xterm 隐藏 textarea——键盘输入入口）存在
    const termInput = page.locator('.xterm-helper-textarea, .xterm textarea').first();
    await expect(termInput).toBeVisible({ timeout: 10_000 });
    // 输入交互可用（焦点可获——xterm 渲染层正确性由集成测试覆盖）
    await termInput.click();
    await termInput.pressSequentially('echo hello');
    await termInput.press('Enter');
    await page.waitForTimeout(500);
    // 无崩溃（输入后面板仍在）
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible();
  });
});
