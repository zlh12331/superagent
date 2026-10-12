// navigation.bench.spec.ts：浏览器模式（dev server）性能基准——首屏可交互、右面板 Tab 切换、
// 输入响应的耗时，以及 DOM 节点数与 console error 的回归门禁
// 入口：pnpm test:perf；Electron 真实窗口的性能基线在 e2e/perf-electron.spec.ts（本文件不覆盖）
import { expect, test } from '@playwright/test';

test.describe('性能基准：页面加载与渲染', () => {
  test('首次加载到可交互 < 3000ms', async ({ page }) => {
    const start = performance.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // 就绪信号取 Topbar 应用名（AppShell 常驻渲染）；ChatInput 的可用状态随会话演进，不如它稳定
    await expect(page.getByText('Code Agent').first()).toBeVisible({
      timeout: 15_000,
    });
    const duration = performance.now() - start;

    // 基线 3000ms 按 dev server 取宽松上限（源码未压缩 + HMR 插桩），只要求回归时立即 fail
    expect(duration, `首次加载耗时 ${duration.toFixed(0)}ms 超过 3000ms 基线`).toBeLessThan(3000);
  });

  test('DOM 节点数 < 5000（防止内存泄漏/过度渲染）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // 计数要落在渲染稳态上（networkidle 只表示网络空闲）

    const nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(nodeCount, `DOM 节点数 ${nodeCount} 超过 5000`).toBeLessThan(5000);
  });

  test('右面板 Tab 切换 < 200ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 右面板默认仅「任务摘要」Tab 常驻，文件变更需先经「添加视图」下拉加入（DevPanel 动态 tab 制）
    await page
      .getByRole('button', { name: /添加视图|Add view/ })
      .first()
      .click();
    await page
      .getByRole('menuitem', { name: /文件变更|Diff/ })
      .first()
      .click();

    // Tab 文案随语言（zh 文件变更 / en Diff），故用双语言正则匹配
    const diffTab = page.getByRole('tab', { name: /文件变更|Diff/ }).first();
    await expect(diffTab).toBeVisible({ timeout: 10_000 });
    const start = performance.now();
    await diffTab.click();
    // 激活态以 Radix Tabs 写在 trigger 上的 data-state="active" 为准
    await expect(diffTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 });
    const duration = performance.now() - start;
    expect(duration, `Tab 切换耗时 ${duration.toFixed(0)}ms 超过 200ms`).toBeLessThan(200);
  });

  test('输入响应 < 100ms（无明显卡顿）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ChatInput 内部即 <textarea>，按元素类型定位更可靠
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

    // 已知无害噪音逐项排除，否则 dev 环境的扩展/遗留报错会淹没真实回归：
    // - React DevTools 扩展提示；ERR_BLOCKED_BY_RESPONSE（扩展 iframe 被 CSP 拦截，
    //   见 src/main/security/csp.ts 的 frame-ancestors 说明）
    // - sentry-ipc:// 与 Sentry SDK 断连提示：Sentry 已从应用移除，已无来源可触发
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
