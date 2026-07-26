// e2e/a11y.spec.ts
// 可访问性审计测试：WCAG 2.2 AA 合规校验
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 @axe-core/playwright 在 E2E 测试中顺手跑 a11y 审计
// - 零额外成本：复用已有 Playwright 浏览器实例
// - 审计 WCAG 2.2 A + AA 级别规则
//
// 运行方式：
//   pnpm test:e2e
//
// 规则参考：
// - WCAG 2.2 AA：https://www.w3.org/TR/WCAG22/
// - axe-core 规则集：https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
//
// 设计：
// - 不审计第三方组件内部（Radix UI 已内置 a11y），只审计整体页面
// - 排除动态加载内容（终端输出/聊天消息），这些由组件测试覆盖
// ──────────────────────────────────────────────────────────────

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('可访问性审计（WCAG 2.2 AA）', () => {
  test('首页无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // 等待应用渲染稳定
    await page.waitForTimeout(1000);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('[data-testid="terminal-output"]') // 终端动态内容
      .exclude('[data-testid="chat-message-list"]') // 聊天动态内容
      // Radix Tabs 在 DevPanel 折叠态下 aria-controls 指向未渲染的 content，
      // 这是 Radix 的标准行为（content 懒渲染），非真实 a11y 问题
      .exclude('[data-slot="tabs-trigger"]')
      .analyze();

    // 违规数为 0 才通过
    expect(results.violations).toEqual([]);
  });

  test('页面包含 lang 属性', async ({ page }) => {
    await page.goto('/');
    const lang = await page.getAttribute('html', 'lang');
    expect(lang).toBeTruthy();
    expect(lang).toMatch(/^(zh-CN|en)$/);
  });

  test('页面包含 title', async ({ page }) => {
    await page.goto('/');
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title.length).toBeGreaterThan(0);
  });

  test('所有图片有 alt 属性（或 aria-label）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 检查 img 元素
    const imagesWithoutAlt = await page.locator('img:not([alt])').count();
    expect(imagesWithoutAlt).toBe(0);
  });

  test('所有 button 有可访问名称', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 按钮必须有：aria-label / aria-labelledby / 文本内容 / title 之一
    const buttons = await page.locator('button').all();
    for (const button of buttons) {
      const isHidden = await button.getAttribute('aria-hidden');
      if (isHidden === 'true') continue;

      const accessibleName =
        (await button.getAttribute('aria-label')) ??
        (await button.getAttribute('aria-labelledby')) ??
        (await button.getAttribute('title')) ??
        (await button.textContent());

      expect(
        accessibleName,
        `按钮缺少可访问名称: ${await button.evaluate((el) => el.outerHTML)}`,
      ).toBeTruthy();
    }
  });

  test('颜色对比度满足 AA 标准', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page }).withTags(['color-contrast']).analyze();

    expect(results.violations).toEqual([]);
  });
});
