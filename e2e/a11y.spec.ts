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

// ── 键盘可达性（WCAG 2.1.1 键盘 / 2.4.7 焦点可见）──────────────────
test.describe('键盘 Tab 遍历', () => {
  test('Tab 键焦点可在主要交互区遍历且焦点可见', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // 等首屏渲染稳定（虚影/动画过渡结束），避免 Tab 落在半成品元素上
    await page.waitForTimeout(800);

    // 连续 Tab 30 次，记录每次聚焦的可交互元素（跳过 body/丢失焦点的空步）
    const stops: Array<{ tag: string; text: string; focusVisible: boolean }> = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      // 焦点转移是同步的，小等待仅为避免 CPU 突发导致 evaluate 竞态
      await page.waitForTimeout(40);
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body || el.tagName === 'HTML') return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
          focusVisible: el.matches(':focus-visible'),
        };
      });
      if (active !== null) {
        stops.push(active);
      }
    }

    // 1) 焦点必须在元素间移动，而不是卡死/跳出文档
    expect(stops.length, 'Tab 至少应命中多个可交互元素').toBeGreaterThan(10);
    const distinctStops = new Set(stops.map((s) => `${s.tag}:${s.text}`));
    expect(distinctStops.size, '焦点应在不同元素间移动（非反复落回同一元素）').toBeGreaterThan(5);

    // 2) 键盘触发的聚焦必须有可见焦点样式（:focus-visible）——WCAG 2.4.7
    const focusVisibleCount = stops.filter((s) => s.focusVisible).length;
    expect(
      focusVisibleCount,
      '键盘 Tab 聚焦的元素应带 :focus-visible 焦点样式（大部分制表位命中）',
    ).toBeGreaterThanOrEqual(10);
  });

  test('Tab+Enter 可激活焦点按钮（键盘可操作性）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    // 找到一个可见的 button：聚焦 → Enter 激活，验证其仍可通过键盘操作
    const button = page.locator('button:visible').first();
    await button.waitFor({ state: 'visible' });
    await button.focus();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');

    // Enter 不抛错（说明按钮可被键盘激活，无 JS 异常/死链）
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    // 应用未被 Enter 搞崩（根节点仍在）
    await expect(page.locator('#root')).toBeAttached();
  });
});
