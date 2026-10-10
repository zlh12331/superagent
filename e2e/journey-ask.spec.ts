// e2e/journey-ask.spec.ts：Agent 提问 AskDialog 的用户旅程 E2E（batch 7，浏览器模式）
// 覆盖「点选选项后提交」与「关闭取消」两条分支；全程跑 mock window.api（vite.web.config.ts），
// 提问由 /ask 输入触发 mock 推送——断言范围是弹窗与 store 的接线，不含真实 Agent 回合。

import { expect, test } from '@playwright/test';

test.describe('Agent 提问 AskDialog 用户旅程（batch 7）', () => {
  test.beforeAll(async ({ browser }) => {
    // 预热：webServer 探活只确认服务已监听，vite 冷启动的依赖预打包/首屏编译发生在首次页面请求；
    // 先访问一次并留出编译时间，避免这段耗时落进首个用例的断言窗口
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await page.close();
  });

  test('旅程7：/ask 触发提问弹窗 → 点选选项 → 提交 → 弹窗关闭', async ({ page }) => {
    await page.goto('/');
    // 进入 mock 预置会话（标题取自 mock-api 桩数据；AskDialog 只对激活会话呈现）
    const session = page.getByRole('button', { name: '重构 IPC 定义表' }).first();
    await expect(session).toBeVisible({ timeout: 10_000 });
    await session.click();
    // 会话切换是异步路由跳转：composer 在欢迎页同样存在，不能单独作为导航完成判据，先留出落定时间
    await page.waitForTimeout(500);

    const input = page.locator('.composer textarea, .composer-box textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    // /ask 前缀是 mock 的约定：提交后 600ms 推送一条提问（问题与选项均为固定桩数据）
    await input.fill('/ask 确认操作');
    await page.keyboard.press('Enter');

    // 「确认执行」是提问里的选项按钮；弹窗收起后它随 DOM 一并消失，故复用作「已关闭」的判据
    const dialog = page.getByRole('button', { name: '确认执行' }).first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('是否确认执行此操作？')).toBeVisible({ timeout: 10_000 });

    await dialog.click();
    // 文案来自 i18n key agent.askSubmit（zh-CN = 提交）
    const submitBtn = page.getByRole('button', { name: '提交' }).first();
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await submitBtn.click();

    // 提交成功后 store 移除该提问（ask-dialog 的 handleSubmit → removeAsk），弹窗随之卸载
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

    // 关闭按钮（aria-label = common.close）走 handleCancel：回传空回答并移除本地提问
    const closeBtn = page.getByRole('button', { name: '关闭' }).first();
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });
    await closeBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
