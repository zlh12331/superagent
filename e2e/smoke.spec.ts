// e2e/smoke.spec.ts
// 冒烟测试：验证应用能正常启动
//
// 测试场景：
// 1. 应用启动后页面可见
// 2. 顶栏显示应用名称"网文写作 Agent"
// 3. 占位首页欢迎文案可见
//
// 说明：原业务路由（projects/settings/chat/rag 等）已随数据库层删除，
// 当前仅验证 Electron 模版骨架能正常启动渲染。

import { expect, test } from '@playwright/test';

test.describe('冒烟测试：应用启动', () => {
  test('应用启动后页面正常渲染', async ({ page }) => {
    await page.goto('/');
    // 顶栏显示应用名称
    await expect(page.getByText('网文写作 Agent').first()).toBeVisible({ timeout: 15_000 });
  });

  test('占位首页欢迎文案可见', async ({ page }) => {
    await page.goto('/');
    // 占位首页文案
    await expect(page.getByText('当前为 Electron 模版骨架，业务后端已移除。')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('主题切换按钮可点击', async ({ page }) => {
    await page.goto('/');

    // 点击主题切换按钮（aria-label="切换主题"）
    const themeButton = page.getByRole('button', { name: '切换主题' });
    await expect(themeButton).toBeVisible({ timeout: 10_000 });
    await themeButton.click();
  });
});
