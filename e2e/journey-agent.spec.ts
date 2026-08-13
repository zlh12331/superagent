// e2e/journey-agent.spec.ts
// 核心用户旅程 E2E：Agent 审批流程（batch 2）
// ──────────────────────────────────────────────────────────────
// 旅程 4：Agent 模式 → 工具调用 → 审批弹窗/卡片 → 批准/拒绝 → 结果展示
// 环境：web 模式（mock window.api——mock 推送 agent:approval:request）
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

import {
  sendAndWaitApproval,
  setupChatSession,
  typeMessage,
  waitSendReady,
} from './journey-helpers';

test.describe('Agent 审批用户旅程（batch 2）', () => {
  // 预热：vite 冷启动首屏编译慢——先行访问触发编译
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程4：工具调用 → 审批卡片出现（批准/拒绝按钮）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '帮我执行一个命令');
    await waitSendReady(page);
    // 发送并等待审批卡片（重试——mock 推送时序）
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click();
    });
  });

  test('旅程4：批准 → 卡片状态更新（审批完成）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '帮我部署一下');
    await waitSendReady(page);
    // 等待审批卡片出现 → 点击批准
    const approveBtn = await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click();
    });
    await approveBtn.click();

    // 审批完成：pending 卡片消失（按钮不再可见——状态流转）
    await expect(approveBtn).not.toBeVisible({ timeout: 10_000 });
  });

  test('旅程4：拒绝 → 卡片状态更新（拒绝完成）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '不要执行');
    await waitSendReady(page);
    // 等待审批卡片出现 → 点击拒绝
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click();
    });
    const rejectBtn = page.getByRole('button', { name: /拒绝|取消/ }).first();
    await expect(rejectBtn).toBeVisible({ timeout: 5_000 });
    await rejectBtn.click();

    // 审批完成：pending 卡片消失（按钮不再可见）
    await expect(rejectBtn).not.toBeVisible({ timeout: 10_000 });
  });
});
