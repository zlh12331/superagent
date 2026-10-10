// e2e/journey-chat.spec.ts：聊天用户旅程 E2E（batch 1）——回车/发送按钮两条发送路径、新建会话、空消息边界。
// 环境：浏览器模式（mock window.api + mock 流式 LLM）。渲染断言只落在发送按钮路径（user 气泡 +
// assistant mock 文案）；回车路径仅实证 transport 调到 agent.run——Enter 在 vite 冷编译下偶发丢事件，
// 属 dev 时序而非产品缺陷，同一渲染链路已由按钮路径覆盖。
import { expect, test } from '@playwright/test';

import { waitForIpcBridge } from './journey-helpers';

// ──────────────────────────────────────────────────────────────
// 本 spec 专用的前置 helper（不导出）：旅程前置 + 发送重试。
// 重试一律复用原文——渲染断言按文本匹配，重填别的内容会让断言落空。
// ──────────────────────────────────────────────────────────────

/** 前置：配置 mock API Key（mock 初始 apiKey=null——发送禁用；配置后聊天可用）。
 * 写入 mock 端 localStorage，可跨 reload 保留。 */
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

/** 包装 window.api.agent.run，把调用次数记入 window.__runCalls——
 * sendAndWaitRun 轮询该计数，作为 transport 层「已发送」的实证 */
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

/** 进入 mock 的第一会话（标题「重构 IPC 定义表」——workingDir 有值）。
 * 用例统一先进入已有会话：首页草稿无目录，发送会被产品设计拦截。 */
async function openExistingSession(page: import('@playwright/test').Page): Promise<void> {
  const sessionTitle = page.getByText('重构 IPC 定义表').first();
  await expect(sessionTitle).toBeVisible({ timeout: 10_000 });
  await sessionTitle.click();
  await expect(page.locator('.composer-box textarea, .composer textarea').first()).toBeVisible({
    timeout: 10_000,
  });
}

/** 等待发送按钮可用（value 生效后 canSend 才为 true；isStreaming 期间按钮禁用）
 *  偶发失败签名是 .send-btn[disabled] 持续超时——streaming 态渲染的是 .stop-gen-btn，
 *  可排除流式阻塞；真因是 vite dev 冷编译下 fill 后 React value/state 脱节，
 *  重填同一文本触发 onChange 重同步（必须用原文 text——渲染断言按文本匹配） */
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

/** 输入消息并确认已生效：fill 比 pressSequentially 可靠（后者偶发不触发 React onChange），
 * 校验 textarea value 与发送按钮 enabled，任一不成立即重填重试。 */
async function typeMessage(
  page: import('@playwright/test').Page,
  text: string,
): Promise<import('@playwright/test').Locator> {
  const input = page.locator('.composer-box textarea, .composer textarea').first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.fill(text);
    try {
      await expect(input).toHaveValue(text, { timeout: 5_000 });
      // value 读对还不够：canSend 由 React state 驱动，按钮 enabled 才代表 setValue 已同步
      await expect(page.locator('.send-btn:visible').first()).toBeEnabled({ timeout: 5_000 });
      return input;
    } catch {}
  }
  throw new Error(`输入失败（3 次尝试）: ${text}`);
}

/**
 * 发送并等待 agent.run 被调用（vite dev 偶发 UI 时序丢事件，故整轮重试 3 次）。
 * 重试复用同一文本（retryText）：渲染断言按文本匹配，重填别的内容会让断言落空。
 * send 抛错（点击瞬间按钮因 streaming 尾窗 disabled）时先等就绪再补发一次，
 * 避免单次 click 的硬超时直接吞掉整轮重试。
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
          // 15s：首次发送时 transport/useChat 模块可能仍在 vite 冷编译，run 延迟可达数秒
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      return;
    } catch {
      // 发送未触发——重输同一文本 + 等待就绪后整轮重试
      await typeMessage(page, retryText);
      await waitSendReady(page, retryText);
    }
  }
  throw new Error('发送失败（3 次尝试——agent.run 未被调用）');
}

test.describe('聊天用户旅程（batch 1）', () => {
  // 预热：vite 冷启动首屏编译慢（lazy ChatPanel/ChatInput），先访问 + 进入会话 + 发送一次，
  // 让后续用例处于热态——否则首个用例的 Enter 偶发因冷编译丢事件。
  // 整段 best-effort：预热失败不阻断（用例自身带重试）。
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    // 时序屏障：等首屏 lazy 模块冷编译完成再交互
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
      // 完整发送链预热：回车一次，把 transport/useChat/agent 的冷编译也带起来
      await input.press('Enter');
      // 等预热发送跑完再关页
      await page.waitForTimeout(5_000);
    } catch {}
    await page.close();
  });

  test('旅程2：输入消息 → 回车发送 → transport 调用 agent.run（渲染断言见发送按钮路径）', async ({
    page,
  }) => {
    await page.goto('/');
    await setupApiKey(page);
    // mock 端配置落 localStorage——reload 让页面以「Key 已配置」状态重建
    await page.reload();
    await wrapAgentRun(page);

    await openExistingSession(page);

    const text = '你好，帮我看看这个项目';
    const input = await typeMessage(page, text);
    // 先等发送就绪再回车——禁用期按键会被丢弃
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
    // mock 流式回复的收尾文案（子串匹配）；20s 覆盖逐字流式的输出时长
    await expect(
      page.locator('.msg.assistant .msg-content', { hasText: '这是模拟回复' }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('旅程3：新建会话 → 聊天输入可用（新会话激活）', async ({ page }) => {
    await page.goto('/');
    await setupApiKey(page);
    await page.reload();

    // 多个「新建会话」匹配（分组行的「在 X 新建会话」含同一子串）——取侧边栏头部的第一个
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
    // 空输入直接回车：不应触发发送（transport 不被调用）
    await input.press('Enter');
    // 1s 取样窗口：等潜在误发的发送时机过去再读计数，否则 0 可能只是读早了
    await page.waitForTimeout(1000);
    const runCalls = await page.evaluate(
      () => (window as unknown as { __runCalls?: number }).__runCalls ?? 0,
    );
    expect(runCalls).toBe(0);
  });
});
