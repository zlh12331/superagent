import { expect, test } from '@playwright/test';

test.describe('冒烟测试：应用启动', () => {
  test('应用启动后页面正常渲染', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });
  });

  test('首页渲染 ChatInput 输入框', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10_000 });
  });

  test('主题切换按钮可点击', async ({ page }) => {
    await page.goto('/');

    const themeButton = page.getByRole('button', { name: '切换主题' });
    await expect(themeButton).toBeVisible({ timeout: 10_000 });
    await themeButton.click();
  });
});
