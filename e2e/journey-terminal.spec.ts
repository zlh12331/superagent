import { expect, test } from '@playwright/test';

test.describe('终端用户旅程（batch 3）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程5：Ctrl+` 打开终端 → 新建终端 → xterm 渲染', async ({ page }) => {
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

    const termInput = page.locator('.xterm-helper-textarea, .xterm textarea').first();
    await expect(termInput).toBeVisible({ timeout: 10_000 });
    await page.locator('.xterm-screen, .xterm').first().click();
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
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible();
  });
});
