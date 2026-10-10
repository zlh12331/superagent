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

  const navItem = page.getByRole('tab', { name: '规则与记忆' });
  await expect(navItem).toBeVisible({ timeout: 5_000 });
  await navItem.click();
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

    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

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
    await expect(page.getByRole('button', { name: /清除全部记忆/ })).toHaveCount(0);
  });
});
