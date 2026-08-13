// e2e/journey-settings.spec.ts
// 核心用户旅程 E2E：设置流程（batch 3）
// ──────────────────────────────────────────────────────────────
// 旅程 6：打开设置 → 配置 API Key → 模型列表更新
// 环境：web 模式（mock window.api——localStorage 持久化 key）
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('设置用户旅程（batch 3）', () => {
  // 预热：vite 冷启动首屏编译慢——先行访问触发编译
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程6：打开设置抽屉 → 设置内容渲染', async ({ page }) => {
    await page.goto('/');

    // Topbar 设置按钮
    const settingsBtn = page.getByRole('button', { name: '设置' }).first();
    await expect(settingsBtn).toBeVisible({ timeout: 10_000 });
    await settingsBtn.click();

    // 设置抽屉出现（对话框 + 内容区）
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // 设置内容（通用/模型等 section 存在）
    await expect(dialog.getByText(/通用|模型|API Key/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('旅程6：设置抽屉可交互（关闭）', async ({ page }) => {
    await page.goto('/');

    const settingsBtn = page.getByRole('button', { name: '设置' }).first();
    await expect(settingsBtn).toBeVisible({ timeout: 10_000 });
    await settingsBtn.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // 关闭（Esc 或关闭按钮）
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});
