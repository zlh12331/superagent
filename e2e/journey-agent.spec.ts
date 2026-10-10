import { expect, test } from '@playwright/test';

import {
  chatInput,
  openExistingSession,
  sendAndWaitApproval,
  setupApiKey,
  setupChatSession,
  typeMessage,
  waitSendReady,
} from './journey-helpers';

test.describe('Agent 审批用户旅程（batch 2）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    try {
      await setupApiKey(page);
      await page.reload();
      await openExistingSession(page);
      const input = chatInput(page);
      await input.fill('预热');
      await page.locator('.send-btn:visible').first().waitFor({ timeout: 10_000 });
      await input.press('Enter');
      await page.waitForTimeout(5_000);
    } catch {}
    await page.close();
  });

  test('旅程4：工具调用 → 审批卡片出现（批准/拒绝按钮）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '帮我执行一个命令');
    await waitSendReady(page);
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
  });

  test('旅程4：批准 → 卡片状态更新（审批完成）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '帮我部署一下');
    await waitSendReady(page);
    const approveBtn = await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    await expect(async () => {
      if (await approveBtn.isVisible()) {
        await approveBtn.click();
      }
      await expect(approveBtn).not.toBeVisible();
    }).toPass({ timeout: 15_000 });
  });

  test('旅程4：拒绝 → 卡片状态更新（拒绝完成）', async ({ page }) => {
    await setupChatSession(page);
    await typeMessage(page, '不要执行');
    await waitSendReady(page);
    await sendAndWaitApproval(page, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    const rejectBtn = page.getByRole('button', { name: /拒绝|取消/ }).first();
    await expect(rejectBtn).toBeVisible({ timeout: 5_000 });
    await expect(async () => {
      if (await rejectBtn.isVisible()) {
        await rejectBtn.click();
      }
      await expect(rejectBtn).not.toBeVisible();
    }).toPass({ timeout: 15_000 });
  });
});
