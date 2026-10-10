// journey-settings.spec.ts：设置用户旅程 E2E——命令面板打开设置 → 内容渲染 → Esc 关闭
// web 模式（--mode web，window.api 由 dev/mock-api.ts 注入）；顶栏无设置按钮（产品决策），入口固定为命令面板的「打开设置」

import { expect, test } from '@playwright/test';

test.describe('设置用户旅程（batch 3）', () => {
  // 预热：vite 冷启动首屏编译慢——先行访问触发编译（各 journey spec 的 beforeAll 分工，见 e2e/journey-helpers.ts）
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

    // cmdk 的 CommandItem 渲染为 role=option（可访问名取标题文本）
    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();

    // 设置抽屉是 Sheet（@radix-ui/react-dialog）→ role=dialog
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // 命中任一即可：通用/模型/快捷键是常驻导航标题，API Key 来自默认落地的「模型」分区
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

    // Esc 关闭：Sheet 与 Dialog 同源，继承 Radix 的键盘取消
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});
