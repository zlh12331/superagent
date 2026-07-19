// src/main/services/settings.service.test.ts
// settings.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ProjectSetting / AppSetting 模型

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts）
const { mockProjectSetting, mockKeychain, mockGetOpenAIClient, mockTestEmbeddingConnection } =
  vi.hoisted(() => ({
    mockProjectSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    mockKeychain: {
      setSecret: vi.fn(),
      getSecret: vi.fn(),
      deleteSecret: vi.fn(),
    },
    // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
    mockGetOpenAIClient: vi.fn(),
    mockTestEmbeddingConnection: vi.fn(),
  }));

// mock PrismaClient 单例模块（spread 共享 mock + 覆盖 projectSetting）
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    projectSetting: mockProjectSetting,
  }),
}));

// mock keychain 模块（避免实际读写文件）
vi.mock('../infra/storage/keychain', () => mockKeychain);

// mock OpenAI 客户端工厂（避免真实网络请求）
vi.mock('../infra/ai/openai-client', () => ({
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  getOpenAIClient: mockGetOpenAIClient,
}));

// mock embedding 服务（ollama 连通性检查）
vi.mock('./embedding.service', () => ({
  testEmbeddingConnection: mockTestEmbeddingConnection,
}));

import {
  getProjectSettings,
  setApiKey,
  testApiKey,
  updateProjectSettings,
} from './settings.service';

describe('settings.service', () => {
  beforeEach(() => {
    // resetMocks 重置共享 mockPrismaClient（保持完整 9 方法）
    // 局部 mock（mockProjectSetting / mockKeychain）需单独 reset
    resetMocks();
    mockProjectSetting.findUnique.mockReset();
    mockProjectSetting.upsert.mockReset();
    mockKeychain.setSecret.mockReset();
    mockKeychain.getSecret.mockReset();
    mockKeychain.deleteSecret.mockReset();
    mockGetOpenAIClient.mockReset();
    mockTestEmbeddingConnection.mockReset();
  });

  describe('getProjectSettings', () => {
    it('应返回已存在的项目设置', async () => {
      const now = new Date();
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: true,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: now,
      });

      const result = await getProjectSettings('p1');

      expect(mockProjectSetting.findUnique).toHaveBeenCalledWith({ where: { projectId: 'p1' } });
      expect(result.projectId).toBe('p1');
      expect(result.aiModel).toBe('deepseek-v4-flash');
    });

    it('设置不存在时应返回默认值（不持久化）', async () => {
      mockProjectSetting.findUnique.mockResolvedValue(null);

      const result = await getProjectSettings('p1');

      expect(result.aiModel).toBe('deepseek-v4-flash');
      expect(result.aiTemperature).toBe(0.7);
      expect(result.ragEnabled).toBe(true);
    });
  });

  describe('updateProjectSettings', () => {
    it('应 upsert 项目设置', async () => {
      const now = new Date();
      mockProjectSetting.upsert.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.9,
        aiMaxTokens: 8192,
        ragEnabled: true,
        ragTopK: 10,
        ragThreshold: 0.8,
        customPrompts: {},
        updatedAt: now,
      });

      const result = await updateProjectSettings({
        projectId: 'p1',
        aiTemperature: 0.9,
        aiMaxTokens: 8192,
      });

      expect(mockProjectSetting.upsert).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        create: expect.objectContaining({
          projectId: 'p1',
          aiTemperature: 0.9,
          aiMaxTokens: 8192,
        }),
        update: expect.objectContaining({
          aiTemperature: 0.9,
          aiMaxTokens: 8192,
        }),
      });
      expect(result.aiTemperature).toBe(0.9);
    });
  });

  describe('setApiKey', () => {
    it('应存储 DeepSeek API Key 到 keychain', async () => {
      mockKeychain.setSecret.mockResolvedValue(undefined);

      const result = await setApiKey('deepseek', 'sk-xxx');

      expect(mockKeychain.setSecret).toHaveBeenCalledWith('deepseek-api-key', 'sk-xxx');
      expect(result).toEqual({ ok: true });
    });

    it('应存储 Ollama API Key 到 keychain', async () => {
      mockKeychain.setSecret.mockResolvedValue(undefined);

      const result = await setApiKey('ollama', 'key-xxx');

      expect(mockKeychain.setSecret).toHaveBeenCalledWith('ollama-api-key', 'key-xxx');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('testApiKey', () => {
    it('deepseek Key 不存在时返回 ok=false', async () => {
      mockKeychain.getSecret.mockResolvedValue(null);

      const result = await testApiKey('deepseek');

      expect(mockKeychain.getSecret).toHaveBeenCalledWith('deepseek-api-key');
      expect(result).toEqual({ ok: false });
      expect(mockGetOpenAIClient).not.toHaveBeenCalled();
    });

    it('deepseek 调用成功应返回 ok=true 与 latencyMs', async () => {
      mockKeychain.getSecret.mockResolvedValue('sk-xxx');
      const mockList = vi.fn().mockResolvedValue({ data: [] });
      mockGetOpenAIClient.mockResolvedValue({ models: { list: mockList } });

      const result = await testApiKey('deepseek');

      expect(mockGetOpenAIClient).toHaveBeenCalledWith({ apiKey: 'sk-xxx' });
      expect(mockList).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toEqual(expect.any(Number));
    });

    it('deepseek 调用失败应返回 ok=false（不抛出）', async () => {
      mockKeychain.getSecret.mockResolvedValue('sk-bad');
      mockGetOpenAIClient.mockRejectedValue(new Error('HTTP 401'));

      const result = await testApiKey('deepseek');

      expect(result).toEqual({ ok: false });
    });

    it('ollama 应跳过 keychain 直接测连通性（成功）', async () => {
      mockTestEmbeddingConnection.mockResolvedValue({ ok: true, latencyMs: 42 });

      const result = await testApiKey('ollama');

      expect(mockKeychain.getSecret).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, latencyMs: 42 });
    });

    it('ollama 连通性检查失败应返回 ok=false', async () => {
      mockTestEmbeddingConnection.mockResolvedValue({ ok: false });

      const result = await testApiKey('ollama');

      expect(result).toEqual({ ok: false });
    });
  });
});
