import { expect, test } from '@playwright/test';

test.describe('Agent 提问 AskDialog 用户旅程（batch 7）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程7：/ask 触发提问弹窗 → 点选选项 → 提交 → 弹窗关闭', async ({ page }) => {
    await page.goto('/');
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('/ask 确认操作');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('button', { name: '确认执行' }).first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('是否确认执行此操作？')).toBeVisible({ timeout: 10_000 });

    await dialog.click();
    const submitBtn = page.getByRole('button', { name: '提交' }).first();
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await submitBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('旅程7：/ask 取消 → 弹窗关闭（回传空回答）', async ({ page }) => {
    await page.goto('/');
    const session = page.getByRole('button', { name: '修复双折叠态主区崩溃' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('/ask 再问一次');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('button', { name: '确认执行' }).first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const closeBtn = page.getByRole('button', { name: '关闭' }).first();
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });
    await closeBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
