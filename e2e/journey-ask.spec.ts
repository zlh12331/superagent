// e2e/journey-ask.spec.ts
// 核心用户旅程 E2E：Agent 提问 AskDialog（batch 7）
// ──────────────────────────────────────────────────────────────
// 环境：web 模式（mock window.api——/ask 输入触发 mock 推送 agent:event:ask）
// 覆盖报告指出的 ask-dialog 空白：agent 提问弹窗出现 → 用户点选/输入 → 提交 → 回合继续
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('Agent 提问 AskDialog 用户旅程（batch 7）', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：vite 冷启动首屏编译慢——先行访问触发编译
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程7：/ask 触发提问弹窗 → 点选选项 → 提交 → 弹窗关闭', async ({ page }) => {
    await page.goto('/');
    // 进入既有会话（mock-1 重构 IPC 定义表）
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    // 输入 /ask 触发 mock 推送提问
    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('/ask 确认操作');
    await page.keyboard.press('Enter');

    // AskDialog 弹出（mock 延迟 600ms 推送）
    const dialog = page.getByRole('button', { name: '确认执行' }).first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // 问题正文可见
    await expect(page.getByText('是否确认执行此操作？')).toBeVisible({ timeout: 10_000 });

    // 点选「确认执行」选项
    await dialog.click();
    // 提交（提交按钮：askSubmit 中文）
    const submitBtn = page.getByRole('button', { name: '提交' }).first();
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await submitBtn.click();

    // 弹窗关闭（提交后 clearAsk）
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('旅程7：/ask 取消 → 弹窗关闭（回传空回答）', async ({ page }) => {
    await page.goto('/');
    const session = page.getByRole('button', { name: '修复双折叠态主区崩溃' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    await page.waitForTimeout(500);

    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('/ask 再问一次');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('button', { name: '确认执行' }).first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // 点右上角关闭（common.close）→ 走 handleCancel → 回传空回答
    const closeBtn = page.getByRole('button', { name: '关闭' }).first();
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });
    await closeBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
