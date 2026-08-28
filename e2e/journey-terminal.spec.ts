// e2e/journey-terminal.spec.ts
// 核心用户旅程 E2E：终端流程（batch 3）
// ──────────────────────────────────────────────────────────────
// 旅程 5：快捷键打开终端 → 新建终端 → xterm 渲染 → 输入
// 环境：web 模式（mock window.api——mock PTY 输出/回显）
// 入口说明（2026-08 对齐现 UI）：DevPanel 为动态 tab 制（默认仅任务摘要常驻），
// 「终端」tab 经 Ctrl+` 快捷键自动加入并激活（AppShell onOpenTerminal 机制），
// 旧断言「终端 tab 常驻」已失效，改为真实用户快捷键路径。
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('终端用户旅程（batch 3）', () => {
  // 预热：vite 冷启动首屏编译慢——先行访问触发编译
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程5：Ctrl+` 打开终端 → 新建终端 → xterm 渲染', async ({ page }) => {
    await page.goto('/');

    // 先进入一个既有会话（欢迎页模式右面板隐藏，DevPanel 未挂载；mock 预置会话标题固定）
    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.waitForTimeout(500);

    // 快捷键：Ctrl+`（右面板展开 + devPanelTab 切 terminal，视图自动加入 tab 列表）
    await page.keyboard.press('Control+`');

    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();

    // 自动创建：进入终端视图且无终端时直接创建（用户要求：无「新建终端」按钮）
    // xterm 渲染（输出在 canvas，文本不可断言；输出正确性由集成测试覆盖）
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('旅程5：终端面板可交互（新建 + 输入区存在）', async ({ page }) => {
    await page.goto('/');

    const firstThread = page.getByRole('button', { name: /重构 IPC|修复双|设计令牌/ }).first();
    await expect(firstThread).toBeVisible({ timeout: 10_000 });
    await firstThread.click();
    await page.waitForTimeout(500);

    await page.keyboard.press('Control+`');

    const terminalTab = page.getByRole('tab', { name: '终端' }).first();
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();

    // 自动创建机制（同用例一）：等待 xterm 挂载
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // 输入区（xterm 隐藏 textarea——键盘输入入口）存在
    const termInput = page.locator('.xterm-helper-textarea, .xterm textarea').first();
    await expect(termInput).toBeVisible({ timeout: 10_000 });
    // 交互入口 = 点击终端可视区（真实用户路径）：helper textarea 是跟随光标的
    // 1px 输入代理，光标在首列时正好位于右面板 resizer 热区下方，不能直接点它
    await page.locator('.xterm-screen, .xterm').first().click();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
        ),
      )
      .toBe(true);
    await termInput.pressSequentially('echo hello');
    await termInput.press('Enter');
    await page.waitForTimeout(500);
    // 无崩溃（输入后面板仍在）
    await expect(page.locator('.xterm, [class*="terminal-view"]').first()).toBeVisible();
  });
});
