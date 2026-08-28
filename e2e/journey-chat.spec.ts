// e2e/journey-chat.spec.ts
// 核心用户旅程 E2E：聊天流程 + 会话管理（batch 1）
// ──────────────────────────────────────────────────────────────
// 旅程 2：新建会话 → 输入消息 → 发送 → 流式回复显示 → 会话入列表
// 旅程 3：会话管理（新建/列表刷新）
// 环境：web 模式（mock window.api——dev mock 全链路，LLM 为 mock 流式）
//
// 渲染断言（P2 补齐，替代原豁免记录）：
// - 发送按钮路径用例断言 user 气泡含所发文本 + assistant 流式回复渲染 mock 文案
// - 回车路径用例保留 transport 层实证（runCalls）——Enter 在 vite 冷编译下偶发丢事件，
//   属 dev 时序而非产品缺陷（按钮路径同链路已覆盖渲染正确性）
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

/** 前置：配置 mock API Key（mock 初始 apiKey=null——发送禁用；配置后聊天可用） */
async function setupApiKey(page: import('@playwright/test').Page): Promise<void> {
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
      // React state 同步：发送按钮 enabled（canSend 依赖 setValue）
      await expect(page.locator('.send-btn:visible').first()).toBeEnabled({ timeout: 5_000 });
      return input;
    } catch {
      // 输入未生效/state 未同步——重试
    }
  }
  throw new Error(`输入失败（3 次尝试）: ${text}`);
}

/**
 * 发送并等待 agent.run 调用（重试——vite dev 环境偶发 UI 时序丢事件）。
 * 重试时复用同一文本（渲染断言按文本匹配，此前硬编码『重试消息』导致断言落空）
 */
async function sendAndWaitRun(
  page: import('@playwright/test').Page,
  retryText: string,
  send: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await send();
    try {
      await expect
        .poll(
          async () =>
            page.evaluate(() => (window as unknown as { __runCalls?: number }).__runCalls ?? 0),
          // 15s：首次发送时 transport/useChat 模块可能仍在 vite 冷编译，run 延迟可达数秒
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      return;
    } catch {
      // 发送未触发——完整重试（重输同一文本 + 等待就绪）
      await typeMessage(page, retryText);
      await waitSendReady(page, retryText);
    }
  }
  throw new Error('发送失败（3 次尝试——agent.run 未被调用）');
}

test.describe('聊天用户旅程（batch 1）', () => {
  // 预热：vite 冷启动首屏编译慢（lazy ChatPanel/ChatInput）——先行访问 + 打开会话 +
  // 输入文字触发编译，后续用例页面加载热（否则首个用例 Enter 偶发因冷编译丢事件）
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
      // 完整发送链预热：等发送按钮可用后回车一次（transport/useChat/agent 模块冷编译）
      await page
        .locator('.send-btn:visible')
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await input.press('Enter');
      await page.waitForTimeout(5_000);
    } catch {
      // 预热失败不影响用例（用例自身有重试）
    }
    await page.close();
  });

  test('旅程2：输入消息 → 回车发送 → transport 调用 agent.run（渲染断言见发送按钮路径）', async ({
    page,
  }) => {
    await page.goto('/');
    await setupApiKey(page);
    // mock key 已 localStorage 持久化——刷新使模型可用性查询生效
    await page.reload();
    await wrapAgentRun(page);

    // 进入已有会话（首页草稿无 workingDir——发送被产品设计拦截）
    await openExistingSession(page);

    const text = '你好，帮我看看这个项目';
    const input = await typeMessage(page, text);
    // 等待发送就绪（canSend——防 Enter 丢失）
    await waitSendReady(page, text);
    // 发送并等待 transport 调用（重试复用同一文本——vite dev 时序）
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
    // 渲染断言：发送按钮路径渲染 user 气泡（含所发文本）
    await expect(page.locator('.msg.user .msg-content', { hasText: text })).toBeVisible({
      timeout: 10_000,
    });
    // 渲染断言：assistant 流式回复最终渲染 mock 文案（消息渲染核心路径自动化兜底）
    await expect(
      page.locator('.msg.assistant .msg-content', { hasText: '这是模拟回复' }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('旅程3：新建会话 → 聊天输入可用（新会话激活）', async ({ page }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();

    // 新建会话按钮（侧边栏 sidebar-head——多个"新建会话"匹配，取第一个）
    const newSessionBtn = page.getByRole('button', { name: '新建会话' }).first();
    await expect(newSessionBtn).toBeVisible({ timeout: 10_000 });
    await newSessionBtn.click();

    // 无异常 + 聊天输入仍可用（新会话已激活）
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
    // 空输入直接回车：不产生消息（transport 不被调用）
    await input.press('Enter');
    await page.waitForTimeout(1000);
    const runCalls = await page.evaluate(
      () => (window as unknown as { __runCalls?: number }).__runCalls ?? 0,
    );
    expect(runCalls).toBe(0);
  });
});
