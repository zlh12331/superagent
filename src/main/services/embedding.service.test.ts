// src/main/services/embedding.service.test.ts
// embedding.service 单元测试
// 设计文档 §4.2 embedding.service / §6.6 Ollama 嵌入

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEmbed, mockLogAiUsage } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockLogAiUsage: vi.fn(),
}));

// config 模块依赖 electron 的 app 对象，测试环境需 mock（参考 logger.test.ts）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
}));

vi.mock('../infra/ai/embedding-client', () => ({
  embed: mockEmbed,
}));

vi.mock('./ai-usage', () => ({
  logAiUsage: mockLogAiUsage,
}));

import { embedTexts, testEmbeddingConnection } from './embedding.service';

describe('embedding.service', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockLogAiUsage.mockReset();
    mockLogAiUsage.mockResolvedValue(undefined);
  });

  describe('embedTexts', () => {
    it('空数组应直接返回空，不调用 infra embed', async () => {
      const result = await embedTexts([]);

      expect(result).toEqual([]);
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('应调用 infra embed 并返回向量，同时记录用量', async () => {
      const vectors = [
        [0.1, 0.2],
        [0.3, 0.4],
      ];
      mockEmbed.mockResolvedValue(vectors);

      const result = await embedTexts(['你好', '世界']);

      expect(mockEmbed).toHaveBeenCalledWith(['你好', '世界']);
      expect(result).toEqual(vectors);
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'ollama',
          status: 'ok',
          inputTokens: 4, // '你好'.length + '世界'.length
        }),
      );
    });

    it('infra embed 失败应包装为 RAG_EMBEDDING_FAILED 并记录 error 用量', async () => {
      mockEmbed.mockRejectedValue(new Error('connection refused'));

      await expect(embedTexts(['x'])).rejects.toMatchObject({
        code: ErrorCode.RAG_EMBEDDING_FAILED,
      });
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'ollama',
          status: 'error',
          error: 'connection refused',
        }),
      );
    });

    it('非 Error 异常应转为字符串记录', async () => {
      mockEmbed.mockRejectedValue('字符串异常');

      await expect(embedTexts(['x'])).rejects.toBeInstanceOf(AppError);
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', error: '字符串异常' }),
      );
    });
  });

  describe('testEmbeddingConnection', () => {
    it('embed 成功应返回 ok=true 与 latencyMs', async () => {
      mockEmbed.mockResolvedValue([[0.1]]);

      const result = await testEmbeddingConnection();

      expect(mockEmbed).toHaveBeenCalledWith(['ping']);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toEqual(expect.any(Number));
    });

    it('embed 失败应返回 ok=false（不抛出异常）', async () => {
      mockEmbed.mockRejectedValue(new Error('ollama down'));

      const result = await testEmbeddingConnection();

      expect(result).toEqual({ ok: false });
    });
  });
});
