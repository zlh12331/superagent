// src/main/infra/ai/chat-service-timeout.test.ts
// ChatService 模型级总时长超时单测（独立文件：需 mock models 注入 timeoutMs，
// 主测试文件保持真实 models 语义以验证 buildGenerationOptions 真实计算）

import { IPC_CHANNELS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockStreamText = vi.fn();
  const mockModel = { __mockModel: true };
  const mockGetModel = vi.fn(async () => mockModel);
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockRandomUUID = vi.fn(() => 'test-session-id');
  // 模型解析：默认无超时；超时用例通过 mockReturnValueOnce 覆盖
  const mockResolveModel = vi.fn(() => ({
    modelId: 'test-model',
    generationConfig: {},
    capabilities: {},
  }));
  return {
    mockStreamText,
    mockGetModel,
    mockModel,
    mockLogger,
    mockRandomUUID,
    mockResolveModel,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: mocks.mockStreamText,
  };
});

vi.mock('./llm-client/ai-provider', () => ({
  getModel: mocks.mockGetModel,
}));

vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

vi.mock('node:crypto', () => ({
  randomUUID: mocks.mockRandomUUID,
}));

// 注意：vi.mock 路径相对测试文件（infra/ai/）解析，models 是同级目录 → './models'
vi.mock('./models', () => ({
  buildGenerationOptions: () => ({}),
  modelRegistry: {
    resolve: mocks.mockResolveModel,
    register: () => {},
  },
}));

import { getChatService, resetChatService } from './agent/chat-service';

type MockedWebContents = WebContents & {
  send: Mock;
  isDestroyed: Mock<() => boolean>;
};

function createMockWebContents(overrides?: { isDestroyed?: boolean }): MockedWebContents {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
  } as unknown as MockedWebContents;
}

describe('ChatService 模型级总时长超时（batch 5/14）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatService();
    mocks.mockRandomUUID.mockReturnValue('test-session-id');
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: {},
      capabilities: {},
    }));
  });

  afterEach(() => {
    resetChatService();
  });

  it('generationConfig.timeoutMs：超时信号触发 → 推送 AI_TIMEOUT 错误', async () => {
    // 模型配置 50ms 总时长超时
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: { timeoutMs: 50 },
      capabilities: {},
    }));
    const wc = createMockWebContents();
    // 流在超时信号触发后报错（模拟 SDK 感知 abort 中断）：100ms error > 50ms 超时
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              controller.error(err);
            }, 100);
          },
        }),
    });

    const service = getChatService();
    await service.startChat({
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 's-mto',
      webContents: wc,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const errorCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_ERROR);
    expect(errorCalls).toHaveLength(1);
    expect((errorCalls[0]?.[1] as { code?: string } | undefined)?.code).toBe('AI_TIMEOUT');
  });
});
