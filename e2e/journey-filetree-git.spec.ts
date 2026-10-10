// e2e/journey-filetree-git.spec.ts：浏览器模式（vite web + mock window.api）下三条用户旅程——
// 文件树展开/查看、Git 面板 status→diff、多会话切换消息不串。
// 断言文本全部取自 mock 预置夹具（会话标题 / 文件列表 / Git 状态与 diff 内容），改夹具需同步本文件。
import { expect, test } from '@playwright/test';

test.describe('文件树 / Git / 多会话用户旅程（batch 6）', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：vite 冷启动首屏编译慢，先访问一次触发编译，避免首个用例等待超时
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程6：文件树展开 → 点文件 → 右面板展示内容', async ({ page }) => {
    await page.goto('/');
    // 进入 mock-1 会话：激活会话的 workingDir 即文件树根目录
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    // 会话项「查看文件」将侧栏切到 fileTree 视图（ui-store 的 sidebarView）
    const openFiles = page.getByRole('button', { name: '查看文件' }).first();
    await expect(openFiles).toBeVisible({ timeout: 10_000 });
    await openFiles.click();
    await page.waitForTimeout(500);

    const tree = page.locator('.file-tree[role="tree"]').first();
    await expect(tree).toBeVisible({ timeout: 10_000 });

    // mock file.list 固定返回 src 目录 + package.json / README.md
    const srcDir = tree.locator('button.ft-row.ft-dir', { hasText: 'src' }).first();
    await expect(srcDir).toBeVisible({ timeout: 10_000 });
    await srcDir.click();
    await page.waitForTimeout(300);

    const pkgFile = tree.locator('button.ft-row.ft-file', { hasText: 'package.json' }).first();
    await expect(pkgFile).toBeVisible({ timeout: 10_000 });
    await pkgFile.click();

    // 点文件自动切右面板「文件」tab；mock file.read 对 .json 返回 { "name": "mock" }
    const fileTab = page.getByRole('tab', { name: '文件' }).first();
    await expect(fileTab).toBeVisible({ timeout: 10_000 });
    const viewer = page.locator('.file-viewer-plaintext').first();
    await expect(viewer).toContainText('mock', { timeout: 10_000 });
  });

  test('旅程6：Git 面板 status 列表 → 点文件看 diff', async ({ page }) => {
    await page.goto('/');
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    // 右面板「添加视图」菜单 → 开发者视图（其子视图默认停在 git）
    const addView = page.getByRole('button', { name: '添加视图' }).first();
    await expect(addView).toBeVisible({ timeout: 10_000 });
    await addView.click();
    const devItem = page.getByRole('menuitem', { name: '开发者' }).first();
    await expect(devItem).toBeVisible({ timeout: 10_000 });
    await devItem.click();
    await page.waitForTimeout(500);

    const devTab = page.getByRole('tab', { name: '开发者' }).first();
    await expect(devTab).toBeVisible({ timeout: 10_000 });
    // Git 状态条按 class 定位：.font-serif 是分支名，.text-success-text 是 ↑ahead（mock：main / ahead=2）
    const branch = page.locator('.font-serif').filter({ hasText: 'main' }).first();
    await expect(branch).toBeVisible({ timeout: 10_000 });
    const ahead = page.locator('.text-success-text').filter({ hasText: '↑2' }).first();
    await expect(ahead).toBeVisible({ timeout: 10_000 });

    // 点文件行展示 diff（mock git.diff 固定含「新内容」）
    const fileItem = page
      .locator('button')
      .filter({ hasText: 'docs/design/09-ux-interaction-spec.md' })
      .first();
    await expect(fileItem).toBeVisible({ timeout: 10_000 });
    await fileItem.click();
    await page.waitForTimeout(500);
    await expect(page.getByText('新内容').first()).toBeVisible({ timeout: 10_000 });
  });

  test('旅程6：多会话切换 → 消息不串', async ({ page }) => {
    await page.goto('/');
    const session1 = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session1).toBeVisible({ timeout: 10_000 });
    await session1.click();
    await page.waitForTimeout(500);

    // mock-1 的 user 消息原文（取自 mock 夹具）
    const msg1 = page.locator('.msg.user .msg-content').first();
    await expect(msg1).toContainText('帮我把 IPC 定义表拆成 meta 和 definitions', {
      timeout: 10_000,
    });

    const session2 = page.getByRole('button', { name: '修复双折叠态主区崩溃' }).first();
    await expect(session2).toBeVisible({ timeout: 10_000 });
    await session2.click();
    await page.waitForTimeout(500);

    // 反向断言：切换后不得残留上一会话的消息——「消息不串」即本用例的契约
    const msg2 = page.locator('.msg.user .msg-content').first();
    await expect(msg2).toContainText('修复双折叠', { timeout: 10_000 });
    await expect(msg2).not.toContainText('IPC 定义表');
  });
});
