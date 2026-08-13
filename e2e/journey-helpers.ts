// e2e/journey-helpers.ts
// 用户旅程 E2E 公共 helper（web 模式 mock 环境）

import { expect, type Locator, type Page } from '@playwright/test';

/** 聊天输入框（composer 区域——页面可能多个 textarea，精确限定） */
export function chatInput(page: Page): Locator {
  return page.locator('.composer-box textarea, .composer textarea').first();
}

/** 前置：配置 mock API Key（mock 初始 apiKey=null——发送禁用；配置后聊天可用） */
export async function setupApiKey(page: Page): Promise<void> {
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
export async function wrapAgentRun(page: Page): Promise<void> {
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
export async function openExistingSession(page: Page): Promise<void> {
  const sessionTitle = page.getByText('重构 IPC 定义表').first();
  await expect(sessionTitle).toBeVisible({ timeout: 10_000 });
  await sessionTitle.click();
  await expect(chatInput(page)).toBeVisible({ timeout: 10_000 });
}

/** 等待发送按钮可用（value 生效后 canSend true；isStreaming 期间禁用） */
export async function waitSendReady(page: Page): Promise<void> {
  const sendBtn = page.locator('.send-btn:visible').first();
  await expect(sendBtn).toBeVisible({ timeout: 10_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
      return;
    } catch {
      // React state 偶发脱节（vite 冷启动）——重填输入触发 onChange 重同步
      await chatInput(page).fill('重试同步');
      await page.waitForTimeout(500);
    }
  }
  throw new Error('发送按钮不可用（3 次重试）');
}

/** 输入消息（fill 触发 input 事件；验证 value + React state 同步） */
export async function typeMessage(page: Page, text: string): Promise<Locator> {
  const input = chatInput(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.fill(text);
    try {
      await expect(input).toHaveValue(text, { timeout: 3_000 });
      await expect(page.locator('.send-btn:visible').first()).toBeEnabled({ timeout: 3_000 });
      return input;
    } catch {
      // 输入未生效/state 未同步——重试
    }
  }
  throw new Error(`输入失败（3 次尝试）: ${text}`);
}

/** 发送并等待 agent.run 调用（重试——vite dev 环境偶发 UI 时序丢事件） */
export async function sendAndWaitRun(page: Page, send: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await send();
    try {
      await expect
        .poll(
          async () =>
            page.evaluate(() => (window as unknown as { __runCalls?: number }).__runCalls ?? 0),
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0);
      return;
    } catch {
      // 发送未触发——完整重试（重输 + 等待就绪）
      await typeMessage(page, '重试消息');
      await waitSendReady(page);
    }
  }
  throw new Error('发送失败（3 次尝试——agent.run 未被调用）');
}

/** 标准旅程前置序列（预热已由各 spec 的 beforeAll 承担——此处为用例内序列） */
export async function setupChatSession(page: Page): Promise<void> {
  await page.goto('/');
  await setupApiKey(page);
  await page.reload();
  await wrapAgentRun(page);
  await openExistingSession(page);
}

/** 发送并等待审批卡片出现（mock 每次推审批——偶发订阅时序丢事件，重发重试） */
export async function sendAndWaitApproval(page: Page, send: () => Promise<void>): Promise<Locator> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendAndWaitRun(page, send);
    // 审批卡片按钮（批准/同意/执行——pending 状态）
    const btn = page.getByRole('button', { name: /批准|同意|执行/ }).first();
    try {
      await expect(btn).toBeVisible({ timeout: 12_000 });
      return btn;
    } catch {
      // 卡片未出现——重发
      await typeMessage(page, '重试审批请求');
      await waitSendReady(page);
    }
  }
  throw new Error('审批卡片未出现（3 次发送尝试）');
}
