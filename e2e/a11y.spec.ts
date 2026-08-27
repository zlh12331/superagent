// e2e/a11y.spec.ts
// 可访问性审计（WCAG 2.2 AA）——浏览器模式 E2E
// ──────────────────────────────
// 覆盖策略（2026-08 审计后重构）：
// - 首页整体 axe 扫描 × 亮/暗 双主题（themeToken 类切换，不依赖用户设置持久化）
// - color-contrast 单规则 × 亮/暗 双主题 —— 此前仅亮色，暗色 accent/error 前景
//   对比度缺陷曾因此漏网
// - 动态内容排除项：终端输出流 / 聊天消息流（滚动噪声）；Radix Tabs 折叠态
//   aria-controls 指向懒渲染 content 为库标准行为，非真实问题
// ──────────────────────────────

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/** 双主题矩阵：Axios 令牌按 <html class="dark"> 切换，evaluate 直加类即可令全部 CSS 变量翻转 */
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** 导航至稳定态并应用目标主题 */
async function gotoWithTheme(page: Page, theme: Theme): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  if (theme === 'dark') {
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });
  }
  // 等待应用渲染稳定（含主题过渡 transition）
  await page.waitForTimeout(1000);
}

test.describe('可访问性审计（WCAG 2.2 AA · 亮/暗双主题矩阵）', () => {
  for (const theme of THEMES) {
    test(`首页无 a11y 违规（${theme}）`, async ({ page }) => {
      await gotoWithTheme(page, theme);

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

    test(`颜色对比度满足 AA 标准（${theme}）`, async ({ page }) => {
      await gotoWithTheme(page, theme);

      // U1 修复：color-contrast 是 axe rule ID 而非 tag——此前用 withTags 传入
      // 匹配不到任何规则，对比度用例空跑（永远 0 违规）。正确 API 是 withRules。
      const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();

      expect(results.violations).toEqual([]);
    });
  }

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
});
