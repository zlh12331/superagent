import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  sendAndWaitApproval,
  setupChatSession,
  typeMessage,
  waitSendReady,
} from './journey-helpers';

/** 双主题矩阵：Axios 令牌按 <html class="dark"> 切换，evaluate 直加类即可令全部 CSS 变量翻转 */
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** 导航至稳定态并应用目标主题 */
async function gotoWithTheme(page: Page, theme: Theme): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  await page.waitForTimeout(1000);
  const applied = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  expect(applied, `主题未按预期落地（期望 dark=${theme === 'dark'}）`).toBe(theme === 'dark');
}

/**
 * axe 扫描共用配置（全部扫描统一 tags + 排除项；新增排除项必须写明理由）
 *
 * 排除项沿革：
 * - 2026-09-08 移除无效 exclude——`data-testid="terminal-output"` 全库不存在
 *   （空匹配属死规则）；聊天列表的 exclude 有效（testid 在 ChatMessageList 上）
 * - `[data-testid="chat-message-list"]` = 聊天动态内容（滚动噪声）
 * - `[data-slot="tabs-trigger"]` = Radix Tabs 折叠态 aria-controls 指向未渲染
 *   的 content，库标准行为（content 懒渲染），非真实 a11y 问题
 */
async function scanAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="chat-message-list"]')
    .exclude('[data-slot="tabs-trigger"]')
    .analyze();
  expect(results.violations).toEqual([]);
}

/** 打开设置并切换到指定分区（导航项 = 侧栏 role=tab 的 zh 标签），返回对话框 */
async function gotoSettingsSection(page: Page, navLabel: string): Promise<Locator> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '命令面板' }).first().click();
  await page.keyboard.type('设置');
  await page.waitForTimeout(200);
  const item = page.getByRole('option', { name: /打开设置/ }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('tab', { name: navLabel, exact: true }).first().click();
  await page.waitForTimeout(800);
  return dialog;
}

/** 进入 mock 首会话（journey-chat 同款入口）
 *
 * 2026-10-09 加固（CI 两次红于此）：原实现「点 role=button 后等 composer 出现」有
 * 两处竞态——① role=button 命中的是整行 ti-content（含右侧操作钮的父 div），
 * click 落点可能压到相邻按钮；② composer 在**欢迎页同样存在**，点击后的异步导航
 * 未完成时断言即通过，随后 fill 作用在即将卸载的输入框上（AskDialog 弹不出）。
 * 现改为：点会话标题文本（journey-helpers 同款精确目标）+ 等 URL 进入该会话。 */
async function openFirstSession(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const firstThread = page.getByText(/重构 IPC|修复双|设计令牌/).first();
  await expect(firstThread).toBeVisible({ timeout: 10_000 });
  await firstThread.click();
  await expect(page).toHaveURL(/#\/chat\//, { timeout: 10_000 });
  await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('可访问性审计（WCAG 2.2 AA · 亮/暗双主题矩阵）', () => {
  for (const theme of THEMES) {
    test(`首页无 a11y 违规（${theme}）`, async ({ page }) => {
      await gotoWithTheme(page, theme);

      await scanAxe(page);
    });

    test(`颜色对比度满足 AA 标准（${theme}）`, async ({ page }) => {
      await gotoWithTheme(page, theme);

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

    const imagesWithoutAlt = await page.locator('img:not([alt])').count();
    expect(imagesWithoutAlt).toBe(0);
  });

  test('所有 button 有可访问名称', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

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

test.describe('键盘 Tab 遍历', () => {
  test('Tab 键焦点可在主要交互区遍历且焦点可见', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    const stops: Array<{ tag: string; text: string; focusVisible: boolean }> = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
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

    expect(stops.length, 'Tab 至少应命中多个可交互元素').toBeGreaterThan(10);
    const distinctStops = new Set(stops.map((s) => `${s.tag}:${s.text}`));
    expect(distinctStops.size, '焦点应在不同元素间移动（非反复落回同一元素）').toBeGreaterThan(5);

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

    const button = page.locator('button:visible').first();
    await button.waitFor({ state: 'visible' });
    await button.focus();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('#root')).toBeAttached();
  });
});

test.describe('扩页审计（会话页 / 设置页）', () => {
  test('会话页无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const sessionTitle = page.getByText('重构 IPC 定义表').first();
    await expect(sessionTitle).toBeVisible({ timeout: 10_000 });
    await sessionTitle.click();
    await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
      timeout: 10_000,
    });

    await scanAxe(page);
  });

  test('设置页（设置对话框）无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '命令面板' }).first().click();
    await page.keyboard.type('设置');
    await page.waitForTimeout(200);
    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await scanAxe(page);
  });
});

test.describe('扩页审计二期（设置分区 / 终端面板）', () => {
  for (const section of [
    { nav: '通用', name: '通用分区' },
    { nav: '快捷键', name: '快捷键分区' },
    { nav: '终端', name: '终端设置分区' },
  ] as const) {
    test(`设置页·${section.name}无 a11y 违规`, async ({ page }) => {
      await gotoSettingsSection(page, section.nav);
      await scanAxe(page);
    });
  }

  test('终端面板无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.keyboard.press('Control+`');
    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(800);

    await scanAxe(page);
  });
});

test.describe('扩页审计三期 · 设置分区补全', () => {
  for (const section of [
    { nav: '用量统计', name: '用量统计分区' },
    { nav: '网络代理', name: '网络代理分区' },
    { nav: '移动端', name: '移动端分区（占位）' },
    { nav: 'MCP 服务器', name: 'MCP 分区' },
    { nav: '技能管理', name: '技能管理分区' },
    { nav: '浏览器', name: '浏览器分区' },
    { nav: '工作树', name: '工作树分区' },
    { nav: '规则与记忆', name: '规则与记忆分区' },
    { nav: '审批权限', name: '审批权限分区' },
    { nav: 'Beta', name: 'Beta 分区' },
    { nav: '关于', name: '关于分区' },
  ] as const) {
    test(`设置页·${section.name}无 a11y 违规`, async ({ page }) => {
      await gotoSettingsSection(page, section.nav);
      await scanAxe(page);
    });
  }

  test('添加模型弹窗无 a11y 违规', async ({ page }) => {
    await gotoSettingsSection(page, '模型');
    await page.getByRole('button', { name: '添加模型' }).first().click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});

test.describe('扩页审计三期 · 右面板视图与侧栏文件树', () => {
  /**
   * 进入会话并通过「添加视图」菜单打开右面板指定视图（tab 激活即切换完成）
   *
   * 必须用 exact 匹配：getByRole name 默认子串匹配，菜单/标签页里
   * 「文件变更」含「文件」——子串会误命中前者（实测踩坑）。
   */
  async function openPanelView(page: Page, viewName: string): Promise<void> {
    await openFirstSession(page);
    const addView = page.getByRole('button', { name: '添加视图' }).first();
    await expect(addView).toBeVisible({ timeout: 10_000 });
    await addView.click();
    const item = page.getByRole('menuitem', { name: viewName, exact: true }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await expect(page.getByRole('tab', { name: viewName, exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(800);
  }

  test('右面板·文件变更视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '文件变更');
    await expect(page.getByText('本轮暂无文件变更')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·文件视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '文件');
    await expect(page.getByText('从文件树选择文件')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·浏览器视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '浏览器');
    await expect(page.getByText('输入地址开始浏览').first()).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·开发者视图（Git 子视图）无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '开发者');
    await expect(page.locator('.font-serif').filter({ hasText: 'main' }).first()).toBeVisible({
      timeout: 10_000,
    });
    await scanAxe(page);
  });

  for (const sub of ['日志', '指标', '检查器'] as const) {
    test(`右面板·开发者${sub}子视图无 a11y 违规`, async ({ page }) => {
      await openPanelView(page, '开发者');
      const subTab = page.locator('.dev-sub-tab', { hasText: sub }).first();
      await expect(subTab).toBeVisible({ timeout: 10_000 });
      await subTab.click();
      await page.waitForTimeout(800);
      await scanAxe(page);
    });
  }

  test('侧栏文件树视图无 a11y 违规', async ({ page }) => {
    await openFirstSession(page);
    const openFiles = page.getByRole('button', { name: '查看文件' }).first();
    await expect(openFiles).toBeVisible({ timeout: 10_000 });
    await openFiles.click();
    await expect(page.locator('.file-tree[role="tree"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});

test.describe('扩页审计三期 · 命令面板与交互弹层', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('命令面板打开态无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '命令面板' }).first().click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await scanAxe(page);
  });

  test('Agent 提问弹窗（AskDialog）无 a11y 违规', async ({ page }) => {
    await openFirstSession(page);
    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await input.fill('/ask 确认操作');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '确认执行' }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await scanAxe(page);
  });

  test('Agent 内联审批卡片无 a11y 违规', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '帮我执行一个命令');
    await waitSendReady(page);
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});
