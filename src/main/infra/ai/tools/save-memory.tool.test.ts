// src/main/infra/ai/tools/save-memory.tool.test.ts
// save_memory 工具单测：真实 MemoryService（内存 DB，无 LLM 调用）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../../storage/schema';
import { SCHEMA_SQL } from '../../storage/schema-sql';
import { SessionService } from '../../storage/session-service';
import type { LlmClient } from '../llm-client';
import { MemoryService } from '../memory-service';
import type { ToolContext } from '../tool';
import { createSaveMemoryTool } from './save-memory.tool';

// mock getDb：内存数据库（建表 SQL 单一真源）
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
}

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
  let memoryDb: ReturnType<typeof createInMemoryDb> | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createInMemoryDb();
      }
      return memoryDb.db;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

import { resetDb } from '../../storage/db';

/** fake LlmClient（save_memory 不调用 LLM，仅构造需要） */
function createFakeLlm(): LlmClient {
  return {
    generateJson: vi.fn(async () => ({ facts: [], preferences: [] })),
  } as unknown as LlmClient;
}

describe('save_memory 工具', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
  });

  async function createSession(): Promise<string> {
    return sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
  }

  it('保存记忆：内容落库可召回', async () => {
    const sid = await createSession();
    const service = new MemoryService(createFakeLlm());
    const tool = createSaveMemoryTool(service);
    const ctx = { sessionId: sid } as unknown as ToolContext;

    const result = await tool.execute(
      { content: '用户使用 pnpm 10 管理依赖', kind: 'preference' },
      ctx,
    );
    expect(result.title).toContain('记忆已保存');

    const entries = await service.recall(sid);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toContain('pnpm 10');
    expect(entries[0]?.kind).toBe('preference');
  });

  it('敏感信息过滤：含 api key 的内容被跳过', async () => {
    const sid = await createSession();
    const service = new MemoryService(createFakeLlm());
    const tool = createSaveMemoryTool(service);
    const ctx = { sessionId: sid } as unknown as ToolContext;

    await tool.execute({ content: '我的 API Key 是 sk-abc1234567890abcdef' }, ctx);

    expect(await service.recall(sid)).toHaveLength(0);
  });
});
