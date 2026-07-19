// src/main/services/ai-usage.test.ts
// ai-usage 单元测试
// 设计文档 §6.2 AiUsageLog 模型

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockAiUsageLog } = vi.hoisted(() => ({
  mockAiUsageLog: {
    create: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    aiUsageLog: mockAiUsageLog,
  }),
}));

import { logAiUsage } from './ai-usage';

describe('ai-usage', () => {
  beforeEach(() => {
    resetMocks();
    mockAiUsageLog.create.mockReset();
  });

  describe('logAiUsage', () => {
    it('应写入成功用量记录', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 1500,
        status: 'ok',
      });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: {
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          inputTokens: 100,
          outputTokens: 200,
          durationMs: 1500,
          status: 'ok',
        },
      });
    });

    it('可选字段缺省时应用默认值 0', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({ provider: 'ollama', model: 'nemotron-3-embed-1b-bf16', status: 'ok' });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: {
          provider: 'ollama',
          model: 'nemotron-3-embed-1b-bf16',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          status: 'ok',
        },
      });
    });

    it('status=error 时应写入 error 字段', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'error',
        error: 'HTTP 429',
      });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'error', error: 'HTTP 429' }),
      });
    });

    it('DB 写入失败时应吞掉异常（仅 warn，不阻塞业务流程）', async () => {
      mockAiUsageLog.create.mockRejectedValue(new Error('DB down'));

      await expect(
        logAiUsage({ provider: 'deepseek', model: 'm', status: 'ok' }),
      ).resolves.toBeUndefined();
    });
  });
});
