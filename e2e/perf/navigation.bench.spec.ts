import { expect, test } from '@playwright/test';

test.describe('性能基准：页面加载与渲染', () => {
  test('首次加载到可交互 < 3000ms', async ({ page }) => {
    const start = performance.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('Code Agent').first()).toBeVisible({
      timeout: 15_000,
    });
    const duration = performance.now() - start;

    expect(duration, `首次加载耗时 ${duration.toFixed(0)}ms 超过 3000ms 基线`).toBeLessThan(3000);
  });

  test('DOM 节点数 < 5000（防止内存泄漏/过度渲染）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(nodeCount, `DOM 节点数 ${nodeCount} 超过 5000`).toBeLessThan(5000);
  });

  test('右面板 Tab 切换 < 200ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page
      .getByRole('button', { name: /添加视图|Add view/ })
      .first()
      .click();
    await page
      .getByRole('menuitem', { name: /文件变更|Diff/ })
      .first()
      .click();

    const diffTab = page.getByRole('tab', { name: /文件变更|Diff/ }).first();
    await expect(diffTab).toBeVisible({ timeout: 10_000 });
    const start = performance.now();
    await diffTab.click();
    await expect(diffTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 });
    const duration = performance.now() - start;
    expect(duration, `Tab 切换耗时 ${duration.toFixed(0)}ms 超过 200ms`).toBeLessThan(200);
  });

  test('输入响应 < 100ms（无明显卡顿）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const input = page.locator('textarea').first();
    await expect(input).toBeVisible({ timeout: 15_000 });

    const start = performance.now();
    await input.fill('test');
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === 'test',
    );
    const duration = performance.now() - start;

    expect(duration, `输入响应耗时 ${duration.toFixed(0)}ms 超过 100ms`).toBeLessThan(100);
  });

  test('console 无 error 级别日志', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const realErrors = errors.filter(
      (err) =>
        !err.includes('React DevTools') &&
        !err.includes('Download the React DevTools') &&
        !err.includes('ERR_BLOCKED_BY_RESPONSE') &&
        !err.includes('sentry-ipc://') &&
        !err.includes('Sentry SDK failed to establish connection'),
    );

    expect(
      realErrors,
      `页面存在 ${realErrors.length} 个 console error:\n${realErrors.join('\n')}`,
    ).toEqual([]);
  });
});
