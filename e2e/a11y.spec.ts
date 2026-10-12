// e2e/a11y.spec.ts：可访问性审计（WCAG 2.2 AA）——axe 扫描 + 键盘 Tab 可达性，浏览器模式 E2E（window.api 来自 src/renderer/dev/mock-api.ts）
// 覆盖面：首页（亮/暗双主题矩阵）、会话页、设置 15 个分区全量、右面板各视图、命令面板与 Agent 交互弹层；除首页外均为默认暗色单主题。
// 各用例导航后普遍再等数百毫秒——动效过渡/懒挂载无可等事件，过早扫描会取到半成品节点产生假违规；axe 扫描统一走 scanAxe。

import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  sendAndWaitApproval,
  setupChatSession,
  typeMessage,
  waitSendReady,
} from './journey-helpers';

/** 双主题矩阵：全量 CSS 变量挂在 html.dark 覆盖块上（src/renderer/styles/tokens.css），evaluate 直加类即令令牌整体翻转 */
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** 导航至稳定态并应用目标主题 */
async function gotoWithTheme(page: Page, theme: Theme): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // 必须双向 toggle：首帧主题由页面内联脚本抢先决定，无 localStorage 镜像时回退 'dark'
  // （src/renderer/lib/theme-init.ts 的 DEFAULT_THEME + src/renderer/index.html 内联脚本），
  // 只 add('dark') 会让 light 分支实际也在测暗色
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  // 等主题过渡（CSS transition）结束：过早扫描取到半应用的样式会产生假违规
  await page.waitForTimeout(1000);
  // 断言主题真落地：防分支再次静默失效（首帧脚本时序变化会覆盖 class）
  const applied = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  expect(applied, `主题未按预期落地（期望 dark=${theme === 'dark'}）`).toBe(theme === 'dark');
}

/**
 * axe 扫描共用配置：所有扫描统一 tags + 排除项，新增排除项必须写明理由
 *
 * tags = WCAG 2.0/2.1 的 A + AA 规则集（axe 按 tag 交集启用规则）。
 * 排除项必须是有效匹配，空匹配等于死规则：
 * - `[data-testid="chat-message-list"]` = 聊天动态内容（滚动噪声），testid 落在 ChatMessageList 上；
 * - `[data-slot="tabs-trigger"]` = Radix Tabs 折叠态 aria-controls 指向懒渲染的 content，库标准行为，非真实 a11y 问题。
 * 反例：不要再加 `data-testid="terminal-output"` 排除项——该 testid 全库不存在。
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
  await page.waitForTimeout(200); // cmdk 防抖：过滤结果未收敛时命中不可靠
  const item = page.getByRole('option', { name: /打开设置/ }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // exact 匹配：getByRole name 默认子串匹配，分区名互为子串时会误命中
  await dialog.getByRole('tab', { name: navLabel, exact: true }).first().click();
  // 等分区内容懒挂载 + 过渡结束（半成品元素会产生假违规）
  await page.waitForTimeout(800);
  return dialog;
}

/** 进入 mock 首会话（会话入口与 e2e/journey-helpers.ts 的 openExistingSession 同款）
 *
 * 以下两处竞态曾两次红在 CI，故不用更直觉的写法：
 * ① 用 role=button 定位会命中整行会话容器（含右侧操作钮），click 落点可能压到相邻按钮；
 * ② composer 在欢迎页同样存在，异步导航未完成时断言即通过，随后 fill 作用在即将卸载的
 * 输入框上（AskDialog 弹不出）。改用：点会话标题文本 + 等 URL 落到会话路由后再断言 composer。 */
async function openFirstSession(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const firstThread = page.getByText(/重构 IPC|修复双|设计令牌/).first();
  await expect(firstThread).toBeVisible({ timeout: 10_000 });
  await firstThread.click();
  // 等导航真正落到会话路由（欢迎页无此 URL；composer 两页皆有，不可作判据）
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

      // 用 withRules 而非 withTags：color-contrast 是 axe 的 rule ID 不是 tag，
      // 传给 withTags 匹配不到任何规则——用例会静默空跑（恒 0 违规）
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
      // 焦点转移本身是同步的；40ms 只为避开 CPU 突发下 evaluate 读取竞态
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

    // Enter 命中哪个按钮不可预知，故退化为弱断言——只验应用未被 Enter 搞崩（#root 仍在）
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
    // 终端入口同 journey-terminal：Ctrl+` 绑定在 src/renderer/hooks/use-keyboard-shortcuts.ts（展开右面板并切到终端 tab）
    await page.keyboard.press('Control+`');
    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();
    // 同 journey-terminal 的等待信号：xterm DOM 挂载完成才可扫描
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
    // 空态即就绪信号（mock 无 edit/write 记录）
    await expect(page.getByText('本轮暂无文件变更')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·文件视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '文件');
    // 空态引导文案出现即懒加载 chunk 就绪
    await expect(page.getByText('从文件树选择文件')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·浏览器视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '浏览器');
    // web 模式无 WebContentsView，进程外预览降级为空态提示
    await expect(page.getByText('输入地址开始浏览').first()).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·开发者视图（Git 子视图）无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '开发者');
    // Git 默认子视图就绪信号：分支名按 .font-serif 定位（src/renderer/components/git/git-panel-parts.tsx；mock 分支 main）
    await expect(page.locator('.font-serif').filter({ hasText: 'main' }).first()).toBeVisible({
      timeout: 10_000,
    });
    await scanAxe(page);
  });

  for (const sub of ['日志', '指标', '检查器'] as const) {
    test(`右面板·开发者${sub}子视图无 a11y 违规`, async ({ page }) => {
      await openPanelView(page, '开发者');
      // .dev-sub-tab 是裸 <button> 的 ui-consistency 豁免标记（src/renderer/components/layout/DevPanel.tsx），形态稳定可作选择器
      const subTab = page.locator('.dev-sub-tab', { hasText: sub }).first();
      await expect(subTab).toBeVisible({ timeout: 10_000 });
      await subTab.click();
      await page.waitForTimeout(800);
      await scanAxe(page);
    });
  }

  test('侧栏文件树视图无 a11y 违规', async ({ page }) => {
    await openFirstSession(page);
    // 「查看文件」把侧栏切到 fileTree 视图（ui-store 的 sidebarView，同 journey-filetree-git）
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
    // 预热：vite 冷启动首屏编译慢——先行访问触发编译（各 journey spec 的 beforeAll 分工，见 e2e/journey-helpers.ts）
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
    // /ask 前缀是 mock 约定：提交后 600ms 推送提问（路径同 journey-ask）
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
    // 等审批卡出现（重试与 reload 兜底都内建在 sendAndWaitApproval 里）
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});
