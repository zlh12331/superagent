// e2e/debug.spec.ts
// 调试用：检查渲染层状态（验证 mock fallback 是否工作）
import { expect, test } from '@playwright/test';

test('调试：检查渲染层状态', async ({ page }) => {
  // 导航到应用
  await page.goto('/');

  // 等待页面加载
  await page.waitForTimeout(3000);

  // 检查 URL
  console.log('URL:', page.url());

  // 检查 window.api 是否存在（Playwright 浏览器模式下应为 undefined，走 createMockApi fallback）
  const apiExists = await page.evaluate(
    () => typeof (window as unknown as Record<string, unknown>).api,
  );
  console.log('window.api type:', apiExists);

  // 检查页面标题
  const title = await page.title();
  console.log('Page title:', title);

  // 检查 body 内容
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Body text:', bodyText);

  expect(true).toBe(true);
});
