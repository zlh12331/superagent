// e2e/journey-agent.spec.ts：浏览器模式 E2E——Agent 审批旅程（工具调用 → 内联审批卡片 → 批准/拒绝）
// window.api 由 src/renderer/dev/mock-api.ts 提供，mock 经 agent:approval:request 推送审批请求；
// 三个用例分段覆盖契约：卡片出现 / 批准后卡片收敛 / 拒绝后卡片收敛

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
  // 预热：vite dev 冷启动首次编译慢，且本批首个用例要跑通完整发送链（transport/useChat/
  // 审批卡片组件均为冷编译）——先自跑一遍轻量发送，别让首个用例独自承担编译耗时
  // （同 e2e/journey-chat.spec.ts 的预热策略）。catch 为空是刻意为之：用例自带前置与
  // 重试，预热失败不应让整个批次失败
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
    // 高负载下点击可能落在 React 重渲染间隙而丢失——反复点击直至状态翻转（审批按钮消失）
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
    // 同批准用例：点击可能落在重渲染间隙被丢弃，重试到卡片消失为止
    await expect(async () => {
      if (await rejectBtn.isVisible()) {
        await rejectBtn.click();
      }
      await expect(rejectBtn).not.toBeVisible();
    }).toPass({ timeout: 15_000 });
  });
});
