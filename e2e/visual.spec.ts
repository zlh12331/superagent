// e2e/visual.spec.ts
// 视觉回归测试：UI 改动像素级对比
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 Playwright 内置 toHaveScreenshot API 对关键界面状态截图
// - 首次运行生成基线图（提交到仓库），后续运行自动 diff
// - 允许 1% 像素差异（抗锯齿/字体渲染等微小差异容忍）
//
// 基线图存储：
//   e2e/visual.spec.ts-snapshots/  （自动生成，需提交到仓库）
//
// 覆盖的三个状态**必须互不相同**（2026-09-17 修复，原实现三张基线 MD5 相同）：
//   1. home                  欢迎页默认态（侧栏展开 + 右面板展开）
//   2. sidebar-collapsed     侧栏折叠态
//   3. right-panel-collapsed 右面板（DevPanel）折叠态
//
// ⚠️ 历史缺陷（勿重蹈）：
// - 原「侧边栏展开态」「DevPanel 展开态」用例的选择器指向**不存在**的 label
//   （/展开侧边栏|切换侧边栏/、/展开开发面板|开发者面板|DevPanel/），且用
//   `if (isVisible) { click }` 静默跳过 ⇒ 三次截图拍的都是同一默认态，三张基线
//   字节完全相同，门禁形同虚设（叠加 1% 阈值把版本号/mock 数据漂移一并吸收）。
//   诱因：devpanel 用例的注释称按钮 aria-label 为「展开开发面板」，而 UI 实际用
//   topbar.expandPanel「展开右侧面板」（panel.expandPanel 该键全仓无使用点）。
// - 修法：按 aria-expanded 读真实状态 + 必要时点击 + 末尾断言目标态；
//   面板开关不存在或状态不符一律失败，不再有静默跳过分支。
// ──────────────────────────────────────────────────────────────

import { expect, type Page, test } from '@playwright/test';

/** 面板开关描述（label 取自真实 i18n：topbar.expandSidebar / topbar.expandPanel） */
interface PanelToggle {
  readonly name: string;
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
  // 品牌标题（role=heading + aria-level=1）可见 = 欢迎页已挂载
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  // 数据就绪：mock 会话条目渲染完成（侧栏默认展开态下可见）
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
  // 基线仅在 Windows 生成（e2e/visual.spec.ts-snapshots/*-win32.png）。
  // Playwright 默认快照名含平台后缀，CI 的 e2e-browser job 跑在 ubuntu-latest，
  // 期望 -linux.png 而基线不存在 → 必然假红。跨平台字体渲染差异无法用阈值抹平，
  // 故非 win32 平台显式跳过（2026-09-06 审计修复；如需 Linux 基线，
  // 应在容器内 --update-snapshots 生成并提交）。
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
});
