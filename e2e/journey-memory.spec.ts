// e2e/journey-memory.spec.ts：记忆管理用户旅程 E2E——开关渲染/切换、引擎状态文案、清除入口的数据门控
// 环境：web 模式（mock window.api）；真实「记忆捕获 → 跨会话召回」链路由 src/main/infra/memory-hub/memory-hub.contract.test.ts 覆盖，本文件只锁 UI 行为
import { expect, test } from '@playwright/test';

/** 打开设置并切到「规则与记忆」面板；自带 page.goto('/')，调用方无需先导航 */
async function openRulesMemoryPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '命令面板' }).first().click();
  await page.keyboard.type('设置');
  await page.waitForTimeout(200);
  await page
    .getByRole('option', { name: /打开设置/ })
    .first()
    .click();

  // 导航项以 tablist 的 role=tab 渲染（SettingsDialog），选择器据此收敛
  const navItem = page.getByRole('tab', { name: '规则与记忆' });
  await expect(navItem).toBeVisible({ timeout: 5_000 });
  await navItem.click();
  // 面板标题可见即确认已切到该分组，后续控件查询才落在正确 pane 上
  await expect(page.getByRole('heading', { name: '记忆' })).toBeVisible({ timeout: 5_000 });
}

test.describe('记忆用户旅程（批次9）', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：vite 冷启动首屏编译慢——先行访问触发编译
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程7：记忆面板渲染开关与状态', async ({ page }) => {
    await openRulesMemoryPanel(page);

    // 开关经 ToggleRow → Radix Switch 渲染（role=switch + aria-checked）；memory.enabled 默认开启
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // mock 引擎状态 available=false → 状态条显示「未随包提供」
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
    // mock 的 sessionCount=0 → 面板按数据量门控该入口：无数据不渲染（避免无对象的破坏性按钮）
    await expect(page.getByRole('button', { name: /清除全部记忆/ })).toHaveCount(0);
  });
});
