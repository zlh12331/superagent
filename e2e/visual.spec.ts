// e2e/visual.spec.ts
// 视觉回归测试：UI 改动像素级对比
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 Playwright 内置 toHaveScreenshot API 对关键页面截图
// - 首次运行生成基线图（提交到仓库），后续运行自动 diff
// - 允许 1% 像素差异（抗锯齿/字体渲染等微小差异容忍）
//
// 运行方式：
//   pnpm test:e2e          # 跑全部浏览器测试（含视觉回归）
//   pnpm exec playwright test --config e2e/playwright.config.ts --update-snapshots
//                         # 主动更新基线图（UI 改动后）
//
// 基线图存储：
//   e2e/visual.spec.ts-snapshots/  （自动生成，需提交到仓库）
//
// 设计参考：
// - Playwright 官方视觉对比：https://playwright.dev/docs/api/test-locator#to-have-screenshot
// - qwen-code-main 的 playwright.visuals.config.ts（独立 viewport）
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('视觉回归测试', () => {
  test('首页主界面快照', async ({ page }) => {
    await page.goto('/');
    // 等待应用完全渲染（React 挂载 + 网络资源加载）
    await page.waitForLoadState('networkidle');
    // Topbar 应用名称可见表明布局已稳定（比 ChatInput 更稳定，不受初始化时序影响）
    await expect(page.getByText('Code Agent').first()).toBeVisible({
      timeout: 15_000,
    });

    // 截图：整个视口
    // maxDiffPixelRatio: 允许 1% 像素差异（字体渲染/抗锯齿容忍）
    // animations: disabled 避免动画过程被截到
    await expect(page).toHaveScreenshot('home.png', {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide', // 隐藏光标（避免光标闪烁导致 diff）
    });
  });

  test('侧边栏展开态快照', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 侧边栏默认折叠，点击展开按钮
    const sidebarToggle = page.getByRole('button', { name: /展开侧边栏|切换侧边栏/ }).first();
    if (await sidebarToggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await sidebarToggle.click();
      // 等待展开动画结束
      await page.waitForTimeout(500);
    }

    await expect(page).toHaveScreenshot('sidebar-expanded.png', {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('DevPanel 展开态快照', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // DevPanel 默认折叠，找到展开按钮
    // DevPanel 触发器在 AppShell 底部，aria-label 为「展开开发面板」
    const devpanelToggle = page
      .getByRole('button', { name: /展开开发面板|开发者面板|DevPanel/ })
      .first();
    if (await devpanelToggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await devpanelToggle.click();
      await page.waitForTimeout(500); // 等待展开动画
    }

    await expect(page).toHaveScreenshot('devpanel-expanded.png', {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
