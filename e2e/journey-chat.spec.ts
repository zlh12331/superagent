import { expect, test } from '@playwright/test';

import { waitForIpcBridge } from './journey-helpers';

/** 前置：配置 mock API Key（mock 初始 apiKey=null——发送禁用；配置后聊天可用） */
async function setupApiKey(page: import('@playwright/test').Page): Promise<void> {
  await waitForIpcBridge(page);
  await page.evaluate(async () => {
    await (
      window as unknown as {
        api: {
          settings: { setApiKey: (p: { provider: string; apiKey: string }) => Promise<unknown> };
        };
      }
    ).api.settings.setApiKey({
      provider: 'deepseek',
      apiKey: 'sk-e2e-test',
    });
  });
}

/** 包装 agent.run（拦截调用计数——transport 发送实证） */
async function wrapAgentRun(page: import('@playwright/test').Page): Promise<void> {
  await waitForIpcBridge(page);
  await page.evaluate(() => {
    const api = window as unknown as {
      api: { agent: { run: (input: unknown) => Promise<unknown> } };
      __runCalls?: number;
    };
    const agent = api.api.agent;
    const origRun = agent.run.bind(agent);
    api.__runCalls = 0;
    agent.run = async (input: unknown) => {
      api.__runCalls = (api.__runCalls ?? 0) + 1;
      return origRun(input);
    };
  });
}

/** 进入已有会话（mock 第一会话——workingDir 有值；首页草稿无目录时发送被产品设计拦截） */
async function openExistingSession(page: import('@playwright/test').Page): Promise<void> {
  const sessionTitle = page.getByText('重构 IPC 定义表').first();
  await expect(sessionTitle).toBeVisible({ timeout: 10_000 });
  await sessionTitle.click();
  await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
    timeout: 10_000,
  });
}

/** 等待发送按钮可用（value 生效后 canSend true；isStreaming 期间禁用）
 *  偶发失败签名是 .send-btn[disabled] 持续超时（streaming 态渲染的是 .stop-gen-btn，
 *  故非流式阻塞）——vite dev 冷编译下 fill 后 React value/state 脱节，重填同一文本
 *  触发 onChange 重同步（复用 helper 手法；文本不变以保末尾 user 气泡断言） */
async function waitSendReady(page: import('@playwright/test').Page, text: string): Promise<void> {
  const sendBtn = page.locator('.send-btn:visible').first();
  await expect(sendBtn).toBeVisible({ timeout: 15_000 });
  const input = page.locator('.composer-box textarea, .composer textarea').first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(sendBtn).toBeEnabled({ timeout: 4_000 });
      return;
    } catch {
      await input.fill(text);
      await page.waitForTimeout(500);
    }
  }
  throw new Error(`发送按钮不可用（3 次重填）: ${text}`);
}

/** 输入消息（fill 触发 input 事件更可靠——pressSequentially 偶发不触发 React onChange；验证 value） */
async function typeMessage(
  page: import('@playwright/test').Page,
  text: string,
): Promise<import('@playwright/test').Locator> {
  const input = page.locator('.composer-box textarea, .composer textarea').first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.fill(text);
    try {
      await expect(input).toHaveValue(text, { timeout: 5_000 });
      await expect(page.locator('.send-btn:visible').first()).toBeEnabled({ timeout: 5_000 });
      return input;
    } catch {}
  }
  throw new Error(`输入失败（3 次尝试）: ${text}`);
}

/**
 * 发送并等待 agent.run 调用（重试——vite dev 环境偶发 UI 时序丢事件）。
 * 重试时复用同一文本（渲染断言按文本匹配，此前硬编码『重试消息』导致断言落空）。
 * send 抛错（点击瞬间按钮因 streaming 尾窗 disabled）时先等就绪再补发一次，
 * 避免单次 click 5s 硬超时直接吞掉整轮重试。
 */
async function sendAndWaitRun(
  page: import('@playwright/test').Page,
  retryText: string,
  send: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await send();
    } catch {
      await waitSendReady(page, retryText);
      await send();
    }
    try {
      await expect
        .poll(
          async () =>
            page.evaluate(() => (window as unknown as { __runCalls?: number }).__runCalls ?? 0),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      return;
    } catch {
      await typeMessage(page, retryText);
      await waitSendReady(page, retryText);
    }
  }
  throw new Error('发送失败（3 次尝试——agent.run 未被调用）');
}

test.describe('聊天用户旅程（batch 1）', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForTimeout(5_000);
    try {
      const title = page.getByText('重构 IPC 定义表').first();
      await title.waitFor({ timeout: 10_000 });
      await title.click();
      const input = page.locator('.composer-box textarea, .composer textarea').first();
      await input.waitFor({ timeout: 10_000 });
      await input.fill('预热');
      await page.locator('.send-btn:visible').first().waitFor({ timeout: 10_000 });
      await page
        .locator('.send-btn:visible')
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await input.press('Enter');
      await page.waitForTimeout(5_000);
    } catch {}
    await page.close();
  });

  test('旅程2：输入消息 → 回车发送 → transport 调用 agent.run（渲染断言见发送按钮路径）', async ({
    page,
  }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();
    await wrapAgentRun(page);

    await openExistingSession(page);

    const text = '你好，帮我看看这个项目';
    const input = await typeMessage(page, text);
    await waitSendReady(page, text);
    await sendAndWaitRun(page, text, async () => {
      await input.press('Enter');
    });
  });

  test('旅程2：发送按钮路径 → transport 调用 agent.run', async ({ page }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();
    await wrapAgentRun(page);
    await openExistingSession(page);

    const text = '用发送按钮';
    await typeMessage(page, text);
    await waitSendReady(page, text);
    await sendAndWaitRun(page, text, async () => {
      await page.locator('.send-btn:visible').first().click({ timeout: 5_000 });
    });
    await expect(page.locator('.msg.user .msg-content', { hasText: text })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.locator('.msg.assistant .msg-content', { hasText: '这是模拟回复' }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('旅程3：新建会话 → 聊天输入可用（新会话激活）', async ({ page }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();

    const newSessionBtn = page.getByRole('button', { name: '新建会话' }).first();
    await expect(newSessionBtn).toBeVisible({ timeout: 10_000 });
    await newSessionBtn.click();

    await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('旅程2边界：空消息不发送', async ({ page }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();
    await wrapAgentRun(page);
    await openExistingSession(page);

    const input = page.locator('.composer-box textarea, .composer textarea').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.press('Enter');
    await page.waitForTimeout(1000);
    const runCalls = await page.evaluate(
      () => (window as unknown as { __runCalls?: number }).__runCalls ?? 0,
    );
    expect(runCalls).toBe(0);
  });
});
