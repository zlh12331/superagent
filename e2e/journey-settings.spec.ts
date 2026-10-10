import { expect, test } from '@playwright/test';

test.describe('设置用户旅程（batch 3）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程6：命令面板打开设置 → 设置内容渲染', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: '命令面板' }).first().click();

    await page.keyboard.type('设置');
    await page.waitForTimeout(200);

    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(/通用|模型|API Key|快捷键/).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('旅程6：设置抽屉可交互（关闭）', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: '命令面板' }).first().click();
    await page.keyboard.type('设置');
    await page.waitForTimeout(200);

    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});
