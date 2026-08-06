// src/main/infra/ai/memory-service.test.ts
// 记忆服务单测：存储/召回/清除/敏感过滤/去重/提取（内存 DB + fake LLM）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../storage/schema';
import { SCHEMA_SQL } from '../storage/schema-sql';
import type { LlmClient } from './llm-client';
import { MemoryService } from './memory-service';

// mock getDb：内存数据库（建表 SQL 单一真源）
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
}

vi.mock('../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/db')>();
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

import { resetDb } from '../storage/db';
import { SessionService } from '../storage/session-service';

/** fake LlmClient（手写最小实现；output 缺省为提取输出） */
function createFakeLlm(output?: unknown, throwError = false): LlmClient {
  return {
    generateJson: vi.fn(async () => {
      if (throwError) {
        throw new Error('API 不可用');
      }
      return output ?? { facts: [], preferences: [] };
    }),
  } as unknown as LlmClient;
}

describe('MemoryService', () => {
  let sessionService: SessionService;

  beforeAll(() => {
    resetDb();
  });

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
    vi.clearAllMocks();
  });

  async function createSession(): Promise<string> {
    return sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
  }

  it('store + recall：记忆条目持久化并可召回', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();

    await service.store(sid, [
      { content: '项目使用 TypeScript 严格模式', kind: 'fact' },
      { content: '用户偏好简洁命名', kind: 'preference' },
    ]);

    const memories = await service.recall(sid);
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      content: '项目使用 TypeScript 严格模式',
      kind: 'fact',
    });
    expect(memories[1]?.kind).toBe('preference');
  });

  it('敏感信息过滤：含 api key / token 的内容跳过', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();

    await service.store(sid, [
      { content: '用户使用 sk-abc1234567890abcdef 作为密钥', kind: 'fact' },
      { content: '这是普通记忆', kind: 'fact' },
    ]);

    const memories = await service.recall(sid);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe('这是普通记忆');
  });

  it('来源回合去重：同回合同内容重复跳过（不同内容都存）', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();

    await service.store(sid, [{ content: '记忆 A', kind: 'fact', sourceTurnId: 't1' }]);
    await service.store(sid, [{ content: '记忆 A', kind: 'fact', sourceTurnId: 't1' }]);
    await service.store(sid, [{ content: '记忆 B', kind: 'fact', sourceTurnId: 't1' }]);

    const memories = await service.recall(sid);
    expect(memories).toHaveLength(2);
  });

  it('clear：清空会话记忆（幂等）', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();
    await service.store(sid, [{ content: '记忆', kind: 'fact' }]);

    await service.clear(sid);
    expect(await service.recall(sid)).toHaveLength(0);
    await service.clear(sid); // 幂等
  });

  it('extractAndStore：LLM 提取并存储（fact + preference）', async () => {
    const fake = createFakeLlm({
      facts: ['项目使用 pnpm workspace'],
      preferences: ['用户偏好中文注释'],
    });
    const service = new MemoryService(fake);
    const sid = await createSession();

    await service.extractAndStore(sid, '用户说项目用 pnpm，喜欢中文注释。', 't1');

    const memories = await service.recall(sid);
    expect(memories).toHaveLength(2);
    expect(memories.some((m) => m.content.includes('pnpm'))).toBe(true);
    expect(memories.some((m) => m.content.includes('中文注释'))).toBe(true);
  });

  it('extractAndStore：提取失败不阻断（静默）', async () => {
    const service = new MemoryService(createFakeLlm(null, true));
    const sid = await createSession();

    await service.extractAndStore(sid, '转录内容', 't1');
    expect(await service.recall(sid)).toHaveLength(0);
  });

  it('extractAndStore：空转录跳过', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();

    await service.extractAndStore(sid, '   ', 't1');
    const fake = service as unknown as { llmClient: { generateJson: ReturnType<typeof vi.fn> } };
    expect(fake.llmClient.generateJson).not.toHaveBeenCalled();
  });

  it('dream：相似记忆融合（重复膨胀收敛）', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();
    await service.store(sid, [
      { content: '用户偏好使用 TypeScript 严格模式', kind: 'preference', sourceTurnId: 't1' },
      {
        content: '用户偏好 TypeScript 严格模式与 noUnusedLocals',
        kind: 'preference',
        sourceTurnId: 't2',
      },
    ]);

    const result = await service.dream(sid);

    expect(result.mergedGroups).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.remainingCount).toBe(1);
    const remaining = await service.recall(sid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.content).toContain('TypeScript');
  });

  it('dream：不相似记忆保留（不同主题不合并）', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await createSession();
    await service.store(sid, [
      { content: '用户使用 Rust 开发 CLI 工具', kind: 'fact', sourceTurnId: 't1' },
      { content: '用户喜欢深色主题界面', kind: 'preference', sourceTurnId: 't2' },
    ]);

    const result = await service.dream(sid);

    expect(result.mergedGroups).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.remainingCount).toBe(2);
  });

  it('dream：指定会话隔离（只整理目标会话）', async () => {
    const service = new MemoryService(createFakeLlm());
    const s1 = await createSession();
    const s2 = await createSession();
    await service.store(s1, [
      { content: '用户偏好 Go 语言', kind: 'preference', sourceTurnId: 't1' },
    ]);
    await service.store(s2, [
      { content: '用户偏好 Go 语言与格式化工具', kind: 'preference', sourceTurnId: 't2' },
    ]);

    await service.dream(s1);

    expect(await service.recall(s2)).toHaveLength(1);
  });

  it('recall：关键词查询过滤并按匹配度排序', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
    await service.store(sid, [
      { content: '用户偏好 TypeScript 严格模式', kind: 'preference' },
      { content: '用户使用 Rust 开发 CLI 工具', kind: 'fact' },
    ]);

    const matched = await service.recall(sid, 'TypeScript');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.content).toContain('TypeScript');
  });

  it('recall：无匹配关键词返回空', async () => {
    const service = new MemoryService(createFakeLlm());
    const sid = await sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
    await service.store(sid, [{ content: '用户偏好 TypeScript', kind: 'preference' }]);
    expect(await service.recall(sid, 'Python')).toHaveLength(0);
  });

  it('forget：LLM 主题提取 + 相似匹配删除', async () => {
    const service = new MemoryService(createFakeLlm({ topics: ['Go 语言'] }));
    const sid = await sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
    await service.store(sid, [
      { content: '用户偏好 Go 语言开发', kind: 'preference' },
      { content: '用户使用 TypeScript 严格模式', kind: 'preference' },
    ]);

    const removed = await service.forget(sid, '忘掉 Go 相关的记忆');
    expect(removed).toBe(1);
    const remaining = await service.recall(sid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.content).toContain('TypeScript');
  });

  it('forget：LLM 失败安全默认不删除', async () => {
    const service = new MemoryService(createFakeLlm(undefined, true));
    const sid = await sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
    await service.store(sid, [{ content: '用户偏好 TypeScript', kind: 'preference' }]);
    expect(await service.forget(sid, '忘掉所有')).toBe(0);
    expect(await service.recall(sid)).toHaveLength(1);
  });

  it('forget：空主题不删除', async () => {
    const service = new MemoryService(createFakeLlm({ topics: [] }));
    const sid = await sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
    await service.store(sid, [{ content: '用户偏好 TypeScript', kind: 'preference' }]);
    expect(await service.forget(sid, '随便说说')).toBe(0);
    expect(await service.recall(sid)).toHaveLength(1);
  });
});
