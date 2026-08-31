// e2e/journey-filetree-git.spec.ts
// 核心用户旅程 E2E：文件树操作 / Git 面板 / 多会话切换（batch 6）
// ──────────────────────────────────────────────────────────────
// 环境：web 模式（mock window.api——mock 预置会话/文件树/Git status+diff）
// 覆盖报告指出的 100% 空白主线：
//  A. 文件树：切到文件树 → 展开 → 点文件 → 右面板「文件」tab 展示内容
//  B. Git 面板：右面板加「开发者」视图 → Git 子视图 status 列表 → 点文件看 diff
//  C. 多会话切换：两个会话间来回切，消息不串
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('文件树 / Git / 多会话用户旅程（batch 6）', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：vite 冷启动首屏编译慢——先行访问触发编译
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程6：文件树展开 → 点文件 → 右面板展示内容', async ({ page }) => {
    await page.goto('/');
    // 进入既有会话（mock-1 重构 IPC 定义表，workingDir f:\TraeProjects\1）
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    // 打开文件树：会话项「查看文件」按钮 → sidebarView 'fileTree'
    const openFiles = page.getByRole('button', { name: '查看文件' }).first();
    await expect(openFiles).toBeVisible({ timeout: 10_000 });
    await openFiles.click();
    await page.waitForTimeout(500);

    // 文件树根区域可见（role=tree）
    const tree = page.locator('.file-tree[role="tree"]').first();
    await expect(tree).toBeVisible({ timeout: 10_000 });

    // 展开 src 目录（mock file.list 返回 src/package.json/README.md）
    const srcDir = tree.locator('button.ft-row.ft-dir', { hasText: 'src' }).first();
    await expect(srcDir).toBeVisible({ timeout: 10_000 });
    await srcDir.click();
    await page.waitForTimeout(300);

    // 点 package.json 文件 → 右面板自动切「文件」tab + 展示内容
    const pkgFile = tree.locator('button.ft-row.ft-file', { hasText: 'package.json' }).first();
    await expect(pkgFile).toBeVisible({ timeout: 10_000 });
    await pkgFile.click();

    // 右面板「文件」tab + 内容断言（mock file.read 对 .json 返回 { "name": "mock" }）
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

    // 右面板「+」添加视图 → 开发者（git 是默认子视图）
    const addView = page.getByRole('button', { name: '添加视图' }).first();
    await expect(addView).toBeVisible({ timeout: 10_000 });
    await addView.click();
    const devItem = page.getByRole('menuitem', { name: '开发者' }).first();
    await expect(devItem).toBeVisible({ timeout: 10_000 });
    await devItem.click();
    await page.waitForTimeout(500);

    // 开发者 tab 出现（git 默认子视图），Git 按钮可点
    const devTab = page.getByRole('tab', { name: '开发者' }).first();
    await expect(devTab).toBeVisible({ timeout: 10_000 });
    // Git 子视图默认激活：分支 main + 文件列表渲染（mock git.status）
    const branch = page.locator('.font-serif').filter({ hasText: 'main' }).first();
    await expect(branch).toBeVisible({ timeout: 10_000 });
    const ahead = page.locator('.text-success-text').filter({ hasText: '↑2' }).first();
    await expect(ahead).toBeVisible({ timeout: 10_000 });

    // 点文件项看 diff（mock git.diff 含「新内容」）
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
    // 两个会话：mock-1「重构 IPC 定义表」、mock-2「修复双折叠态主区崩溃」
    const session1 = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session1).toBeVisible({ timeout: 10_000 });
    await session1.click();
    await page.waitForTimeout(500);

    // mock-1 的 user 消息
    const msg1 = page.locator('.msg.user .msg-content').first();
    await expect(msg1).toContainText('帮我把 IPC 定义表拆成 meta 和 definitions', {
      timeout: 10_000,
    });

    // 切到会话 2（修复双折叠态主区崩溃）
    const session2 = page.getByRole('button', { name: '修复双折叠态主区崩溃' }).first();
    await expect(session2).toBeVisible({ timeout: 10_000 });
    await session2.click();
    await page.waitForTimeout(500);

    // 断言切换后显示会话 2 的消息（不串会话 1 的）
    const msg2 = page.locator('.msg.user .msg-content').first();
    await expect(msg2).toContainText('修复双折叠', { timeout: 10_000 });
    await expect(msg2).not.toContainText('IPC 定义表');
  });
});
