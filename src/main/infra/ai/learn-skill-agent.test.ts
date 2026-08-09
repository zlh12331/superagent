// src/main/infra/ai/learn-skill-agent.test.ts
// 技能学习单测：引导模板 + 学习/列出/删除（内存 DB + fake LLM）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, resetDb } from '../storage/db';
import { schema } from '../storage/schema';
import { SCHEMA_SQL } from '../storage/schema-sql';
import { buildLearnSkillPrompt, LearnSkillService } from './knowledge/learn-skill-agent';
import type { LlmClient } from './llm-client/llm-client';
import { skillRegistry } from './skills/skill-registry';

// mock getDb：内存数据库
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

/** fake LlmClient */
function createFakeLlm(output?: unknown, throwError = false): LlmClient {
  return {
    generateJson: vi.fn(async () => {
      if (throwError) {
        throw new Error('API 不可用');
      }
      return (
        output ?? {
          name: 'sql_optimization',
          description: '优化慢 SQL 查询',
          prompt:
            'When to Use: 遇到慢查询时。Procedure: 1. 分析执行计划 2. 定位全表扫描 3. 加索引验证。Pitfalls: 不要盲目加索引。',
        }
      );
    }),
  } as unknown as LlmClient;
}

describe('buildLearnSkillPrompt（纯函数）', () => {
  it('包含知识源与安全约束', () => {
    const prompt = buildLearnSkillPrompt('学会优化 SQL', ['code_review']);
    expect(prompt).toContain('<user_data>');
    expect(prompt).toContain('学会优化 SQL');
    expect(prompt).toContain('code_review');
    expect(prompt).toContain('web_fetch');
  });

  it('无现有技能时不输出清单行', () => {
    const prompt = buildLearnSkillPrompt('x', []);
    expect(prompt).not.toContain('不得复用');
  });
});

describe('LearnSkillService', () => {
  let service: LearnSkillService;

  beforeEach(() => {
    resetDb();
    service = new LearnSkillService(createFakeLlm());
    vi.clearAllMocks();
  });

  it('learn：LLM 提炼 → 持久化 → 注册表动态注册', async () => {
    const result = await service.learn('教我怎么优化慢 SQL');
    expect(result.skill.name).toBe('sql_optimization');
    expect(result.replaced).toBe(false);
    // 持久化
    expect(await service.listLearned()).toHaveLength(1);
    // 注册表立即可加载（load_skill 工具语义）
    expect(skillRegistry.load('sql_optimization')?.description).toContain('慢 SQL');
  });

  it('learn：同名覆盖（replaced=true）', async () => {
    await service.learn('第一次');
    const result = await service.learn('第二次（改良版）');
    expect(result.replaced).toBe(true);
    expect(await service.listLearned()).toHaveLength(1);
  });

  it('learn：LLM 失败抛错（不落库）', async () => {
    const failing = new LearnSkillService(createFakeLlm(undefined, true));
    await expect(failing.learn('x')).rejects.toThrow('技能提炼失败');
    expect(await failing.listLearned()).toHaveLength(0);
  });

  it('remove：删除已学习技能（注册表移除）', async () => {
    await service.learn('教我怎么写 commit message');
    expect(service.remove('sql_optimization')).toBe(true);
    expect(await service.listLearned()).toHaveLength(0);
    // 注册表移除（内置回退：该名不在内置集则彻底移除）
    expect(skillRegistry.load('sql_optimization')).toBeUndefined();
  });

  it('remove：不存在返回 false（幂等）', () => {
    expect(service.remove('not_exist')).toBe(false);
  });

  it('listLearned：排序稳定（按名）', async () => {
    const llm = createFakeLlm({ name: 'a_skill', description: 'A', prompt: 'P'.repeat(20) });
    const s1 = new LearnSkillService(llm);
    await s1.learn('A');
    const llm2 = createFakeLlm({ name: 'b_skill', description: 'B', prompt: 'P'.repeat(20) });
    const s2 = new LearnSkillService(llm2);
    await s2.learn('B');
    const list = await service.listLearned();
    expect(list.map((s) => s.name)).toEqual(['a_skill', 'b_skill']);
    void getDb;
  });
});
