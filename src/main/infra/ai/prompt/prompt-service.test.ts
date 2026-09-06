// src/main/infra/ai/prompt/prompt-service.test.ts
// PromptService 单测：initialize 幂等 / CRUD / DB 失败回退默认（内存 DB）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, resetDb } from '../../storage/db';
import { createTestDb } from '../../storage/test-utils';
import { DEFAULT_CODE_AGENT_PROMPT } from './default-prompt';
import { DEFAULT_CODE_AGENT_PROMPT_ID, PromptService } from './prompt-service';

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
  let memoryDb: ReturnType<typeof createTestDb>['db'] | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createTestDb().db;
      }
      return memoryDb;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

describe('PromptService', () => {
  let service: PromptService;

  beforeEach(() => {
    resetDb();
    service = new PromptService();
    void getDb;
  });

  it('initialize 幂等：重复调用只插入一次默认 prompt', () => {
    service.initialize();
    service.initialize();
    expect(service.listPrompts()).toHaveLength(1);
    expect(service.getPrompt(DEFAULT_CODE_AGENT_PROMPT_ID)?.content).toBe(
      DEFAULT_CODE_AGENT_PROMPT,
    );
  });

  it('不覆盖已编辑内容（用户改动不被 initialize 重置）', () => {
    service.initialize();
    service.updatePrompt(DEFAULT_CODE_AGENT_PROMPT_ID, '我的自定义 prompt');
    service.initialize();
    expect(service.getPrompt(DEFAULT_CODE_AGENT_PROMPT_ID)?.content).toBe('我的自定义 prompt');
  });

  it('updatePrompt 返回是否成功', () => {
    service.initialize();
    expect(service.updatePrompt(DEFAULT_CODE_AGENT_PROMPT_ID, 'v2')).toBe(true);
    expect(service.updatePrompt('ghost', 'v2')).toBe(false);
  });

  it('resolvePrompt：数据库有 → source=database 并注入动态上下文', async () => {
    service.initialize();
    const resolved = await service.resolvePrompt(DEFAULT_CODE_AGENT_PROMPT_ID, '/tmp/nonexist-dir');
    expect(resolved.source).toBe('database');
    expect(resolved.content).toContain('Code Agent');
  });

  it('resolvePrompt：数据库无记录 → 回退硬编码默认（source=default-fallback）', async () => {
    const resolved = await service.resolvePrompt(DEFAULT_CODE_AGENT_PROMPT_ID, '/tmp/nonexist-dir');
    expect(resolved.source).toBe('default-fallback');
    expect(resolved.content).toContain('Code Agent');
  });
});
