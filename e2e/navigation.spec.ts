// e2e/navigation.spec.ts
// 路由导航测试
// 设计文档 §8.4 E2E 测试策略 / Phase 10 Task 2
//
// 测试场景：
// 1. 从项目列表点击顶栏设置图标 → 跳转到 /settings
// 2. 设置页"应用设置"标题可见
// 3. 从设置页点击侧边栏"项目" → 返回 /projects
//
// 注意：
// - 使用顶栏的设置图标（aria-label="设置"）触发导航
// - 使用侧边栏的 NavLink 文字"项目"返回项目列表

import { expect, test } from '@playwright/test';

test.describe('路由导航', () => {
  test('从项目列表跳转到设置页', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('暂无项目')).toBeVisible({ timeout: 10_000 });

    // 点击顶栏设置图标（aria-label="设置"）
    await page.getByRole('button', { name: '设置' }).click();

    // URL 应跳转到 /settings
    await page.waitForURL('**/settings', { timeout: 10_000 });
    // 设置页"应用设置"标题可见
    await expect(page.getByText('应用设置')).toBeVisible({ timeout: 10_000 });
  });

  test('从设置页返回项目列表', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();
    await page.waitForURL('**/settings', { timeout: 10_000 });
    await expect(page.getByText('应用设置')).toBeVisible({ timeout: 10_000 });

    // 点击侧边栏"项目"导航项
    await page.getByRole('link', { name: '项目' }).click();

    // URL 应返回 /projects
    await page.waitForURL('**/projects', { timeout: 10_000 });
    // 项目列表空状态可见
    await expect(page.getByText('暂无项目')).toBeVisible({ timeout: 10_000 });
  });

  test('主题切换按钮可点击', async ({ page }) => {
    await page.goto('/');

    // 点击主题切换按钮（aria-label="切换主题"）
    const themeButton = page.getByRole('button', { name: '切换主题' });
    await expect(themeButton).toBeVisible({ timeout: 10_000 });
    await themeButton.click();
  });
});
