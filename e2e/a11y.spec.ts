// e2e/a11y.spec.ts
// 可访问性审计（WCAG 2.2 AA）——浏览器模式 E2E
// ──────────────────────────────
// 覆盖策略（2026-08 审计后重构）：
// - 首页整体 axe 扫描 × 亮/暗 双主题（themeToken 类切换，不依赖用户设置持久化）
// - color-contrast 单规则 × 亮/暗 双主题 —— 此前仅亮色，暗色 accent/error 前景
//   对比度缺陷曾因此漏网
// - 动态内容排除项：终端输出流 / 聊天消息流（滚动噪声）；Radix Tabs 折叠态
//   aria-controls 指向懒渲染 content 为库标准行为，非真实问题
// - 扩页扫描（2026-09-27）：会话页（mock 首会话入口，journey-chat 同款）与
//   设置页（命令面板 → 打开设置，journey-settings 同款）
// - 扩页扫描二期（2026-10-07）：设置分区（侧栏导航 tab 切换：通用/快捷键/终端）
//   与终端面板（Ctrl+` 快捷键，journey-terminal 同款）——axe 扫描前等分区
//   懒挂载/过渡结束
// - 扩页扫描三期（2026-10-07，全覆盖收口）：设置其余 11 分区 + 添加模型弹窗
//   （设置 15 分区至此全部覆盖）；右面板 文件变更/文件/浏览器/开发者（Git
//   默认子视图 + 日志/指标/检查器子视图，会话详情随一期会话页、终端随二期）；
//   侧栏文件树（journey-filetree-git 同款「查看文件」入口）；命令面板打开态；
//   Agent 交互弹层（/ask 提问弹窗、内联审批卡——journey-ask/journey-agent
//   同款 mock 路径）。扩页扫描均为默认暗色单主题（双主题矩阵仍仅首页，先例）
// ──────────────────────────────

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
  // 必须显式双向切换：web 模式首帧主题恒为暗色（theme-init.ts 的
  // DEFAULT_THEME='dark' + FOUC 防护内联脚本），只 add('dark') 会让 light
  // 分支实际也在测暗色——双主题矩阵名不副实（2026-09-17 实测发现）
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  // 等待应用渲染稳定（含主题过渡 transition）
  await page.waitForTimeout(1000);
  // 主题落地断言：防止分支再次静默失效（如首帧脚本时序变化覆盖 class）
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
    .exclude('[data-testid="chat-message-list"]') // 聊天动态内容（滚动噪声）
    .exclude('[data-slot="tabs-trigger"]') // Radix Tabs 折叠态 aria-controls（库标准行为）
    .analyze();
  expect(results.violations).toEqual([]);
}

/** 打开设置并切换到指定分区（导航项 = 侧栏 role=tab 的 zh 标签），返回对话框 */
async function gotoSettingsSection(page: Page, navLabel: string): Promise<Locator> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '命令面板' }).first().click();
  await page.keyboard.type('设置');
  await page.waitForTimeout(200); // cmdk 防抖
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

      // 违规数为 0 才通过（tags + 排除项统一走 scanAxe，沿革见其注释）
      await scanAxe(page);
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

// ── 扩页 axe 扫描（2026-09-27）：会话页 / 设置页 ───────────────────
// 入口复用既有旅程基建（journey-chat 的首会话点击 / journey-settings 的
// 命令面板→打开设置），排除项与首页扫描一致。
test.describe('扩页审计（会话页 / 设置页）', () => {
  test('会话页无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 进入已有会话（mock 第一会话「重构 IPC 定义表」，与 journey-chat 同款入口）
    const sessionTitle = page.getByText('重构 IPC 定义表').first();
    await expect(sessionTitle).toBeVisible({ timeout: 10_000 });
    await sessionTitle.click();
    // 等会话视图真正渲染（composer 输入框出现）
    await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
      timeout: 10_000,
    });

    await scanAxe(page);
  });

  test('设置页（设置对话框）无 a11y 违规', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 入口：命令面板（Topbar 文字按钮）→ 过滤 → 打开设置（与 journey-settings 同款）
    await page.getByRole('button', { name: '命令面板' }).first().click();
    await page.keyboard.type('设置');
    await page.waitForTimeout(200); // cmdk 防抖
    const item = page.getByRole('option', { name: /打开设置/ }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await scanAxe(page);
  });
});

// ── 扩页审计二期（2026-10-07）：设置分区 / 终端面板 ───────────────
// 设置分区：打开设置后点侧栏导航（role=tab，zh 标签即 accessible name）；
// 终端面板：Ctrl+` 快捷键（journey-terminal 同款路径）。
// 分区导航与 axe 扫描共用模块级 helper（三期扩页同用）。
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

    // 进入会话（欢迎页右面板隐藏）→ Ctrl+` 打开终端（自动创建）
    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.keyboard.press('Control+`');
    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();
    // xterm 渲染在 canvas（journey-terminal 同款等待），再等稳定
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(800);

    await scanAxe(page);
  });
});

// ── 扩页审计三期（2026-10-07）：设置分区补全 / 设置弹窗 ───────────
// 设置 15 分区全覆盖收口：模型=一期默认分区、通用/快捷键/终端=二期，
// 本批补齐其余 11 分区；附带「添加模型」弹窗（设置域常驻弹窗入口）。
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
    // 等弹窗过渡结束（半成品元素会产生假违规）
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});

// ── 扩页审计三期：右面板视图 / 侧栏文件树 ─────────────────────────
// 右面板六视图全覆盖收口：会话详情随一期会话页（默认视图）、终端随二期
// （Ctrl+`），本批补齐 文件变更/文件/浏览器/开发者。开发者含四个子视图
// （Git 默认 + 日志/指标/检查器 segmented 切换，类名 .dev-sub-tab 为
// ui-consistency 豁免标记、形态稳定可作选择器）。
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
    // 等懒挂载/过渡结束
    await page.waitForTimeout(800);
  }

  test('右面板·文件变更视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '文件变更');
    // 空态渲染完成（mock 无 edit/write 记录 → 空态文案）
    await expect(page.getByText('本轮暂无文件变更')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·文件视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '文件');
    // 懒加载 chunk 就绪（空态引导文案替代 common.loading 兜底）
    await expect(page.getByText('从文件树选择文件')).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·浏览器视图无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '浏览器');
    // 进程外沙箱预览的空态提示（web 模式无 WebContentsView）
    await expect(page.getByText('输入地址开始浏览').first()).toBeVisible({ timeout: 10_000 });
    await scanAxe(page);
  });

  test('右面板·开发者视图（Git 子视图）无 a11y 违规', async ({ page }) => {
    await openPanelView(page, '开发者');
    // Git 默认子视图：分支指示渲染（mock git.status，journey-filetree-git 同款信号）
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
      // 等查询/渲染稳定
      await page.waitForTimeout(800);
      await scanAxe(page);
    });
  }

  test('侧栏文件树视图无 a11y 违规', async ({ page }) => {
    await openFirstSession(page);
    // 会话项「查看文件」按钮 → sidebarView 切文件树（journey-filetree-git 同款）
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

// ── 扩页审计三期：命令面板 / Agent 交互弹层 ───────────────────────
// 命令面板打开态 + Agent 交互两弹层（提问弹窗 / 内联审批卡）。弹层均在
// portal 或 ChatPanel 根层（审批卡不在 chat-message-list 排除区内），
// 标准排除项即可覆盖；mock 路径与 journey-ask / journey-agent 同款。
test.describe('扩页审计三期 · 命令面板与交互弹层', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：vite 冷启动首屏编译慢（journey 系列同款）——交互弹层涉及
    // ChatPanel/transport/审批卡片重组件链路
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
    await page.waitForTimeout(300); // cmdk 渲染
    await scanAxe(page);
  });

  test('Agent 提问弹窗（AskDialog）无 a11y 违规', async ({ page }) => {
    await openFirstSession(page);
    // /ask 触发 mock 推送提问（journey-ask 同款路径，mock 延迟 600ms）
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
    // 发送并等审批卡片出现（重试内建）
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    await page.waitForTimeout(500);
    await scanAxe(page);
  });
});
