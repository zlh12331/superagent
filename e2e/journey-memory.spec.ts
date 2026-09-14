// e2e/journey-memory.spec.ts
// 核心用户旅程 E2E：记忆管理（批次9）
// ──────────────────────────────────────────────────────────────
// 旅程 7：命令面板打开设置 → 切到「规则与记忆」→ 验证记忆管理 UI
//   - 隐私开关渲染（默认开启）与切换
//   - 引擎状态展示（未随包提供时显示对应文案）
//   - 清除全部记忆（有数据时出现；确认后调用 clearAll）
//
// 环境：web 模式（mock window.api）。
//   注：真实的"记忆捕获 → 跨会话召回"链路由 main 契约测试覆盖
//   （memory-hub.contract.test.ts 真实拉起引擎）；本旅程锁 UI 行为。
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

/** 打开设置并切到「规则与记忆」面板 */
async function openRulesMemoryPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '命令面板' }).first().click();
  await page.keyboard.type('设置');
  await page.waitForTimeout(200);
  await page
    .getByRole('option', { name: /打开设置/ })
    .first()
    .click();

  // 设置导航：切到「规则与记忆」分组（导航项 role=tab，见 SettingsDialog 的 tablist）
  const navItem = page.getByRole('tab', { name: '规则与记忆' });
  await expect(navItem).toBeVisible({ timeout: 5_000 });
  await navItem.click();
  // 面板内容挂载（标题渲染）即为切换完成的信号
  await expect(page.getByRole('heading', { name: '记忆' })).toBeVisible({ timeout: 5_000 });
}

test.describe('记忆用户旅程（批次9）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程7：记忆面板渲染开关与状态', async ({ page }) => {
    await openRulesMemoryPanel(page);

    // 隐私开关（ToggleRow 以 role=switch 渲染），默认开启
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // 引擎状态条：mock 返回 available=false → 显示"未随包提供"
    await expect(page.getByText('未随包提供')).toBeVisible({ timeout: 5_000 });
  });

  test('旅程7：切换记忆开关（关闭 → 再开启）', async ({ page }) => {
    await openRulesMemoryPanel(page);

    const toggle = page.getByRole('switch').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  test('旅程7：无数据时不显示"清除全部记忆"', async ({ page }) => {
    await openRulesMemoryPanel(page);
    // mock 的 sessionCount=0 → 按设计不渲染清除全部按钮（避免无数据的破坏性入口）
    await expect(page.getByRole('button', { name: /清除全部记忆/ })).toHaveCount(0);
  });
});
