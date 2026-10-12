// e2e/visual.spec.ts：视觉回归——欢迎页面板状态 + 品牌区的截图基线对比
//
// 基线存 e2e/visual.spec.ts-snapshots/（生成后须提交仓库）；三张面板态基线必须互不相同，
// 否则 1% 阈值（SHOT_OPTIONS.maxDiffPixelRatio）会把版本号 / mock 数据漂移一并吸收，门禁形同虚设。

import { expect, type Page, test } from '@playwright/test';

/** 面板开关描述（label 取自真实 i18n：topbar.expandSidebar / topbar.expandPanel） */
interface PanelToggle {
  readonly name: string; // 面板名，仅用于断言失败消息，不参与元素定位
  // 同一开关按钮两态各持一个 aria-label；定位靠 getByRole 的 accessible name，须与 i18n 实时文案逐字一致
  readonly expandLabel: string;
  readonly collapseLabel: string;
}

const SIDEBAR: PanelToggle = {
  name: '侧边栏',
  expandLabel: '展开侧边栏',
  collapseLabel: '折叠侧边栏',
};

/** 右面板即 DevPanel（Terminal + Git + Files + Logs + Metrics + Inspector） */
const RIGHT_PANEL: PanelToggle = {
  name: '右面板（DevPanel）',
  expandLabel: '展开右侧面板',
  collapseLabel: '折叠右侧面板',
};

/** 截图统一配置：禁 CSS 动画 + 隐藏光标（避免闪烁导致 diff） */
const SHOT_OPTIONS = {
  maxDiffPixelRatio: 0.01,
  animations: 'disabled',
  caret: 'hide',
} as const;

/**
 * 打开欢迎页并等待布局稳定
 *
 * 动效竞态消除：MotionConfig reducedMotion="user" 读 prefers-reduced-motion，
 * 模拟 reduce 可让 framer-motion 的 JS 入场动画即时完成——toHaveScreenshot 的
 * animations:'disabled' 只覆盖 CSS/WAAPI，管不到 JS 驱动的动画。
 *
 * 数据就绪等待（2026-09-17）：mock bridge 由 main.tsx 动态 import 安装，早于
 * IPC 请求返回；仅等 networkidle + 标题可见会**在数据渲染前截图**，拍到会话/任务
 * 区空态（实测：快照显示「尚无会话 / 最近 0」而真实渲染为 3 条 mock 会话）。
 * 故显式等待数据驱动元素出现；若 mock 桥缺失（例如误连 electron-vite dev server
 * ——其 MODE≠web 不注入 mock）则超时失败，顺带 fail-closed 保护测试环境正确性。
 */
async function gotoWelcome(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.thread-item').first()).toBeVisible({ timeout: 15_000 });
}

/** 把面板切到目标态并断言落地；开关缺失或状态不符直接失败（禁止静默跳过） */
async function setPanelExpanded(page: Page, toggle: PanelToggle, expanded: boolean): Promise<void> {
  const button = page
    .getByRole('button', { name: new RegExp(`${toggle.expandLabel}|${toggle.collapseLabel}`) })
    .first();
  await expect(button, `${toggle.name}开关必须存在`).toBeVisible();
  if ((await button.getAttribute('aria-expanded')) !== String(expanded)) {
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-expanded', String(expanded));
}

test.describe('视觉回归测试', () => {
  // 基线仅 win32 生成（Playwright 快照名自带平台后缀，仓内即 -win32.png）；本文件同属浏览器模式套件，
  // CI 的 e2e-browser job 跑 ubuntu-latest，会期待 -linux.png 而基线不存在 → 必然假红。
  // 跨平台字体渲染差异无法用阈值抹平；要放开需先在目标平台生成基线并提交。
  test.skip(process.platform !== 'win32', '视觉基线仅 Windows 维护（需在目标平台生成基线后放开）');

  test('欢迎页默认态快照', async ({ page }) => {
    await gotoWelcome(page);
    // 显式锁定默认态（两个面板展开），不依赖 store 默认值恰好如此
    await setPanelExpanded(page, SIDEBAR, true);
    await setPanelExpanded(page, RIGHT_PANEL, true);

    await expect(page).toHaveScreenshot('home.png', SHOT_OPTIONS);
  });

  test('侧栏折叠态快照', async ({ page }) => {
    await gotoWelcome(page);
    await setPanelExpanded(page, RIGHT_PANEL, true);
    await setPanelExpanded(page, SIDEBAR, false);

    await expect(page).toHaveScreenshot('sidebar-collapsed.png', SHOT_OPTIONS);
  });

  test('右面板折叠态快照', async ({ page }) => {
    await gotoWelcome(page);
    await setPanelExpanded(page, SIDEBAR, true);
    await setPanelExpanded(page, RIGHT_PANEL, false);

    await expect(page).toHaveScreenshot('right-panel-collapsed.png', SHOT_OPTIONS);
  });

  /**
   * 品牌区元素级快照
   *
   * 为什么单独加：全页快照的 1% 阈值（≈9200px @1280x720）会漏掉小面积改动——
   * 2026-09-17 实测把欢迎页品牌图标从细线条换成实心标识（2661px 差异）时全页
   * 基线**照旧通过**。元素级快照把作用域缩到品牌区（约 700x60），同一改动占比
   * 放大到数个百分点，从而可被检出。顶栏标识同理（小尺寸，全页尺度下不可见）。
   */
  test('品牌区快照（欢迎页大字 + 顶栏标识）', async ({ page }) => {
    await gotoWelcome(page);

    await expect(page.locator('.welcome-logo')).toHaveScreenshot('brand-welcome.png', SHOT_OPTIONS);
    await expect(page.locator('.brand').first()).toHaveScreenshot('brand-topbar.png', SHOT_OPTIONS);
  });
});
