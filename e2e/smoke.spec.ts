// e2e/smoke.spec.ts
// 冒烟测试：验证应用能正常启动
// 设计文档 §8.4 E2E 测试策略 / Phase 10 Task 2
//
// 测试场景：
// 1. 应用启动后页面可见
// 2. 标题栏显示"网文写作 Agent"
// 3. 默认路由跳转到 /projects
// 4. 侧边栏导航项可见（项目）
// 5. 顶栏应用名称可见
//
// 注意：
// - 渲染层 mock fallback 返回空数组，所以项目列表为空
// - 无需 Electron，直接测试纯 Web UI

import { expect, test } from '@playwright/test';

test.describe('冒烟测试：应用启动', () => {
  test('应用启动后页面正常渲染', async ({ page }) => {
    await page.goto('/');
    // 顶栏显示应用名称
    await expect(page.getByText('网文写作 Agent')).toBeVisible({ timeout: 15_000 });
  });

  test('默认路由跳转到 /projects', async ({ page }) => {
    await page.goto('/');
    // URL 应包含 /projects
    await page.waitForURL('**/projects', { timeout: 10_000 });
    // 项目列表页空状态文案可见（mock 返回空数组）
    await expect(page.getByText('暂无项目')).toBeVisible({ timeout: 10_000 });
  });

  test('侧边栏"项目"导航项可见', async ({ page }) => {
    await page.goto('/');
    // 侧边栏"项目"导航项可见（NavLink 文字）
    await expect(page.getByRole('link', { name: '项目' })).toBeVisible({ timeout: 10_000 });
  });
});
