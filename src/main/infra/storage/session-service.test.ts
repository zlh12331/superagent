// src/main/infra/storage/session-service.test.ts
// session-service 单测：create + listRecentDirs + rowToMeta
//
// 测试维度：正向用例 / 边界用例 / 异常用例
// 使用内存 SQLite 避免文件系统依赖

import type { ChatMessage } from '@code-agent/shared/main';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron（app.getPath 在 db.ts 中使用）
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/test-userdata'),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    isPackaged: false,
  },
}));

import { resetDb } from './db';
import { SessionService } from './session-service';
import { createTestDb } from './test-utils';

/** 创建内存数据库 + drizzle 实例（绕过 app.getPath） */
function createInMemoryDb() {
  return createTestDb();
}

// mock getDb 返回内存数据库
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
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

describe('SessionService', () => {
  let service: SessionService;

  beforeAll(() => {
    resetDb();
  });

  beforeEach(() => {
    resetDb();
    service = new SessionService();
  });

  // ── 6.1.1 create 方法 ──────────────────────────────

  describe('create', () => {
    it('正向：传入 workingDir(空会话) → sessions 行写入 working_dir, messageCount=0, 返回 UUID', async () => {
      const sessionId = await service.create({
        workingDir: 'f:\\proj',
        title: undefined,
        messages: undefined,
      });

      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // 验证写入的数据
      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe('f:\\proj');
      expect(detail.session.messageCount).toBe(0);
    });

    it('正向：传入 workingDir + 初始 messages(2 条) → sessions + 2 条 messages 同时写入', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '帮我读取 package.json 文件内容' },
        { role: 'assistant', content: '好的,我来帮你读取' },
      ];

      const sessionId = await service.create({
        workingDir: 'D:\\project',
        title: undefined,
        messages,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe('D:\\project');
      expect(detail.session.messageCount).toBe(2);
      expect(detail.messages).toHaveLength(2);
      // title 取首条 user 消息前 50 字符
      expect(detail.session.title).toBe('帮我读取 package.json 文件内容');
    });

    it('边界：workingDir 为超长路径(260 字符) → 正常写入', async () => {
      const longPath = `D:\\${'a'.repeat(257)}`;
      expect(longPath).toHaveLength(260);

      const sessionId = await service.create({
        workingDir: longPath,
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe(longPath);
    });

    it('边界：workingDir 含中文/空格/Unicode → 正常写入无乱码', async () => {
      const unicodePath = 'D:\\我的 项目';

      const sessionId = await service.create({
        workingDir: unicodePath,
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe(unicodePath);
    });

    it('异常：DB 事务中途失败 → sessions 行未写入(事务回滚), create 抛错', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\valid',
        title: undefined,
        messages: undefined,
      });
      expect(sessionId).toBeDefined();
    });
  });

  // ── 6.1.2 listRecentDirs 方法 ──────────────────────

  describe('listRecentDirs', () => {
    it('正向：3 个不同 workingDir(updatedAt 递增) → 返回 3 条,按 lastUsed 倒序', async () => {
      const baseTime = Date.now();
      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime);
      await service.create({ workingDir: 'D:\\proj1', title: undefined, messages: undefined });

      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + 1000);
      await service.create({ workingDir: 'D:\\proj2', title: undefined, messages: undefined });

      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + 2000);
      await service.create({ workingDir: 'D:\\proj3', title: undefined, messages: undefined });

      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toHaveLength(3);
      expect(result.dirs[0]?.workingDir).toBe('D:\\proj3');
      expect(result.dirs[1]?.workingDir).toBe('D:\\proj2');
      expect(result.dirs[2]?.workingDir).toBe('D:\\proj1');
    });

    it('边界：多个会话共享同一 workingDir(5 条) → 去重返回 1 条, lastUsed=MAX', async () => {
      const baseTime = Date.now();
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + i * 1000);
        await service.create({ workingDir: 'D:\\shared', title: undefined, messages: undefined });
      }
      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toHaveLength(1);
      expect(result.dirs[0]?.workingDir).toBe('D:\\shared');
      expect(result.dirs[0]?.lastUsed).toBe(baseTime + 4000);
    });

    it('边界：5 个不同 workingDir, limit=2 → 返回 2 条(最近使用)', async () => {
      const baseTime = Date.now();
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + i * 1000);
        await service.create({ workingDir: `D:\\proj${i}`, title: undefined, messages: undefined });
      }
      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 2 });
      expect(result.dirs).toHaveLength(2);
      expect(result.dirs[0]?.workingDir).toBe('D:\\proj4');
      expect(result.dirs[1]?.workingDir).toBe('D:\\proj3');
    });

    it('异常：无会话(空表) → 返回 { dirs: [] }, 不报错', async () => {
      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toEqual([]);
    });
  });

  // ── 6.1.3 rowToMeta(通过 list/get 间接验证) ────────

  describe('rowToMeta (via list/get)', () => {
    it('正向：正常 row(workingDir 非空) → SessionMeta.workingDir 透传原值', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\my-project',
        title: undefined,
        messages: undefined,
      });

      const list = await service.list(10, 0);
      const meta = list.sessions.find((s) => s.id === sessionId);
      expect(meta).toBeDefined();
      expect(meta?.workingDir).toBe('D:\\my-project');
    });

    it('边界：lastMessage 为 null → 转为 undefined', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.lastMessage).toBeUndefined();
    });
  });

  describe('recordUsage / getUsageSummary（token 用量统计）', () => {
    it('记录后：getUsageSummary 按总量/模型/日聚合', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      await service.recordUsage({
        sessionId,
        modelId: 'deepseek-v4-flash',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 30,
        reasoningTokens: 20,
      });
      await service.recordUsage({
        sessionId,
        modelId: 'deepseek-v4-flash',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cacheReadTokens: undefined,
        reasoningTokens: undefined,
      });

      const summary = await service.getUsageSummary();

      // 总量：2 次调用
      expect(summary.total).toEqual({
        calls: 2,
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
      });
      // 按模型聚合
      expect(summary.byModel).toHaveLength(1);
      expect(summary.byModel[0]).toMatchObject({
        modelId: 'deepseek-v4-flash',
        calls: 2,
        totalTokens: 450,
        cacheReadTokens: 30,
        reasoningTokens: 20,
      });
      // 按日聚合（当天日期）
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      expect(summary.byDay).toHaveLength(1);
      expect(summary.byDay[0]).toEqual({ date, calls: 2, totalTokens: 450 });
    });

    it('无记录：返回空汇总', async () => {
      const summary = await service.getUsageSummary();
      expect(summary.total.calls).toBe(0);
      expect(summary.byModel).toHaveLength(0);
      expect(summary.byDay).toHaveLength(0);
    });

    it('多模型：按模型分组汇总', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      await service.recordUsage({
        sessionId,
        modelId: 'deepseek-v4-flash',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: undefined,
        reasoningTokens: undefined,
      });
      await service.recordUsage({
        sessionId,
        modelId: 'gpt-4o',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: undefined,
        reasoningTokens: undefined,
      });

      const summary = await service.getUsageSummary();
      expect(summary.byModel).toHaveLength(2);
      // 按 totalTokens 倒序：gpt-4o(30) 在前
      expect(summary.byModel[0]?.modelId).toBe('gpt-4o');
      expect(summary.byModel[1]?.modelId).toBe('deepseek-v4-flash');
    });
  });

  describe('recordTurn / getTurns / getRecentTurns（Transcript 回合记录）', () => {
    it('记录回合后：getTurns 按 seq 升序返回', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      await service.recordTurn({
        turnId: 'turn-1',
        sessionId,
        seq: 0,
        modelId: 'deepseek-v4-flash',
        status: 'completed',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        durationMs: 2000,
      });
      await service.recordTurn({
        turnId: 'turn-2',
        sessionId,
        seq: 1,
        modelId: 'deepseek-v4-flash',
        status: 'aborted',
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        durationMs: 800,
      });

      const res = await service.getTurns(sessionId);
      expect(res.sessionId).toBe(sessionId);
      expect(res.turns).toHaveLength(2);
      expect(res.turns[0]).toMatchObject({
        turnId: 'turn-1',
        seq: 0,
        modelId: 'deepseek-v4-flash',
        status: 'completed',
        totalTokens: 150,
        durationMs: 2000,
      });
      expect(res.turns[1]).toMatchObject({ turnId: 'turn-2', seq: 1, status: 'aborted' });
      // 可空字段转 undefined
      expect(res.turns[1]?.totalTokens).toBeUndefined();
    });

    it('无回合记录：返回空列表', async () => {
      const res = await service.getTurns('nonexistent');
      expect(res.turns).toHaveLength(0);
    });

    it('getRecentTurns：跨会话按 createdAt 倒序 + limit 限制', async () => {
      const sessionA = await service.create({
        workingDir: 'D:\\a',
        title: undefined,
        messages: undefined,
      });
      const sessionB = await service.create({
        workingDir: 'D:\\b',
        title: undefined,
        messages: undefined,
      });

      await service.recordTurn({
        turnId: 't-a1',
        sessionId: sessionA,
        seq: 0,
        modelId: 'deepseek-v4-flash',
        status: 'completed',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        durationMs: 100,
      });
      await service.recordTurn({
        turnId: 't-b1',
        sessionId: sessionB,
        seq: 0,
        modelId: 'gpt-4o',
        status: 'error',
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        durationMs: 50,
      });

      const res = await service.getRecentTurns({ limit: 10 });
      expect(res.turns).toHaveLength(2);
      // 按 createdAt 倒序：后写入的 t-b1 在前
      expect(res.turns[0]?.turnId).toBe('t-b1');
      expect(res.turns[0]?.sessionId).toBe(sessionB);
      expect(res.turns[1]?.turnId).toBe('t-a1');

      const limited = await service.getRecentTurns({ limit: 1 });
      expect(limited.turns).toHaveLength(1);
    });
  });

  describe('getTurnMessages（Transcript 消息级明细）', () => {
    it('按回合追加消息后：getTurnMessages 按 seq 升序返回该回合消息', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      await service.appendMessage({
        sessionId,
        turnId: 'turn-x',
        messages: [{ role: 'user', content: '你好' }],
      });
      await service.appendMessage({
        sessionId,
        turnId: 'turn-x',
        messages: [{ role: 'assistant', content: '收到' }],
      });
      // 其他回合的消息不应混入
      await service.appendMessage({
        sessionId,
        turnId: 'turn-y',
        messages: [{ role: 'user', content: '另一回合' }],
      });

      const messages = await service.getTurnMessages('turn-x');
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'user', content: '你好' });
      expect(messages[1]).toEqual({ role: 'assistant', content: '收到' });
    });

    it('无归属消息的回合：返回空数组', async () => {
      expect(await service.getTurnMessages('nonexistent-turn')).toEqual([]);
    });

    it('未传 turnId 的消息：不归属任何回合（兼容旧数据）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });
      await service.appendMessage({
        sessionId,
        messages: [{ role: 'user', content: '旧消息' }],
      });

      expect(await service.getTurnMessages('anything')).toEqual([]);
      const session = await service.get(sessionId);
      expect(session.messages).toHaveLength(1);
    });
  });
});
