// e2e/journey-settings.spec.ts
// 核心用户旅程 E2E：设置流程（batch 3）
// ──────────────────────────────────────────────────────────────
// 旅程 6：打开设置抽屉 → 设置内容渲染 → 关闭
// 环境：web 模式（mock window.api——localStorage 持久化 key）
// 入口路径（用户决策：Topbar 无设置按钮）：命令面板 → 打开设置
// ──────────────────────────────────────────────────────────────

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

    // 入口：命令面板（Topbar 文字按钮，唯一命令面板触发点）
    await page.getByRole('button', { name: '命令面板' }).first().click();

    // 输入搜索词过滤至「打开设置」条目
    await page.keyboard.type('设置');
    await page.waitForTimeout(200); // cmdk 防抖

    // cmdk option 元素（CommandItem 内部 role=option，文本含标题）
    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();

    // 设置对话框出现（Sheet 以 [role="dialog"] 渲染）
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // 设置内容（通用/模型/快捷键等分组）
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

    // 关闭：Esc（Sheet 响应键盘取消）
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});
