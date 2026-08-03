// e2e/smoke.spec.ts
// 冒烟测试：验证应用能正常启动
//
// 测试场景：
// 1. 应用启动后页面可见
// 2. 顶栏显示应用名称"Code Agent Desktop"
// 3. 首页渲染 ChatInput 输入框
// 4. 主题切换按钮可点击

import { expect, test } from '@playwright/test';

test.describe('冒烟测试：应用启动', () => {
  test('应用启动后页面正常渲染', async ({ page }) => {
    await page.goto('/');
    // 顶栏显示应用名称
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });
  });

  test('首页渲染 ChatInput 输入框', async ({ page }) => {
    await page.goto('/');
    // 首页直接渲染 ChatPanel，检查输入框可见
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10_000 });
  });

  test('主题切换按钮可点击', async ({ page }) => {
    await page.goto('/');

    // 点击主题切换按钮（aria-label="切换主题"）
    const themeButton = page.getByRole('button', { name: '切换主题' });
    await expect(themeButton).toBeVisible({ timeout: 10_000 });
    await themeButton.click();
  });
});
