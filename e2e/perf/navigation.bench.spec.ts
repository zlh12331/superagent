// e2e/perf/navigation.bench.spec.ts
// 性能基准：页面导航与渲染耗时基线
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 Playwright + performance.now() 度量关键交互耗时
// - 首次加载耗时 / 路由切换耗时 / 渲染稳定耗时
// - 设定基线阈值，回归时立即 fail（防止性能退化）
//
// 运行方式：
//   pnpm test:e2e -- --grep "性能基准"
//
// 设计参考：
// - opencode-dev/packages/app/e2e/performance/timeline/first-navigation-benchmark.spec.ts
// - Chrome DevTools Performance Panel 的 LCP/FID 指标
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('性能基准：页面加载与渲染', () => {
  test('首次加载到可交互 < 3000ms', async ({ page }) => {
    const start = performance.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // 等待 Topbar 应用名称可见（应用就绪标志，比 ChatInput 更稳定）
    await expect(page.getByText('Code Agent').first()).toBeVisible({
      timeout: 15_000,
    });
    const duration = performance.now() - start;

    // 基线：3000ms（dev mode + Vite + Electron preload）
    // 期望回归时立即可见，而非慢慢退化
    expect(duration, `首次加载耗时 ${duration.toFixed(0)}ms 超过 3000ms 基线`).toBeLessThan(3000);
  });

  test('DOM 节点数 < 5000（防止内存泄漏/过度渲染）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // 等待完全渲染

    const nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(nodeCount, `DOM 节点数 ${nodeCount} 超过 5000`).toBeLessThan(5000);
  });

  test('右面板 Tab 切换 < 200ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 动态 tab 制（2026-08 对齐）：默认仅任务摘要常驻，经「添加视图」下拉加入文件变更视图
    await page
      .getByRole('button', { name: /添加视图|Add view/ })
      .first()
      .click();
    await page
      .getByRole('menuitem', { name: /文件变更|Diff/ })
      .first()
      .click();

    // Tab 文本随语言（zh 文件变更/en Diff），用双语言正则匹配
    const diffTab = page.getByRole('tab', { name: /文件变更|Diff/ }).first();
    await expect(diffTab).toBeVisible({ timeout: 10_000 });
    const start = performance.now();
    await diffTab.click();
    // Radix Tabs 在 trigger 上设置 data-state="active" 表示当前激活的 Tab
    await expect(diffTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 });
    const duration = performance.now() - start;
    expect(duration, `Tab 切换耗时 ${duration.toFixed(0)}ms 超过 200ms`).toBeLessThan(200);
  });

  test('输入响应 < 100ms（无明显卡顿）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ChatInput 渲染为 textarea，用元素类型定位更可靠
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible({ timeout: 15_000 });

    // 测量输入到字符出现的延迟
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

    // 排除已知无害错误：
    // - React DevTools 扩展相关
    // - ERR_BLOCKED_BY_RESPONSE：CSP 与 React DevTools 扩展冲突
    // - Sentry IPC：E2E 浏览器模式下无 main process，Sentry SDK 无法通过
    //   sentry-ipc:// 协议与主进程通信（Electron 模式下正常）
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
