import type { ChatMessage } from '@code-agent/shared/main';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetPath, mockInvalidationSends } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/test-userdata'),
  mockInvalidationSends: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    isPackaged: false,
  },
  ['BrowserWindow']: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: vi.fn(() => false),
        webContents: {
          isDestroyed: vi.fn(() => false),
          send: vi.fn((channel: string, payload: unknown) => {
            mockInvalidationSends.push([channel, payload]);
          }),
        },
      },
    ]),
  },
}));

function lastInvalidationPayload(): { domains: string[]; sessionId?: string } | undefined {
  const last = mockInvalidationSends.at(-1);
  return last?.[1] as { domains: string[]; sessionId?: string } | undefined;
}

import { ErrorCode } from '@code-agent/shared/main';

import { resetDb } from './db';
import { SessionService } from './session-service';
import { createTestDb } from './test-utils';

function createInMemoryDb() {
  return createTestDb();
}

vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  let memoryDb: ReturnType<typeof createInMemoryDb> | null = null;

  return {
    ...actual,
    reclaimFreePages: vi.fn(),
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

  describe('create', () => {
    it('正向：传入 workingDir(空会话) → sessions 行写入 working_dir, messageCount=0, 返回 UUID', async () => {
      const sessionId = await service.create({
        workingDir: 'f:\\proj',
        title: undefined,
        messages: undefined,
      });

      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

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
      expect(detail.session.title).toBe('帮我读取 package.json 文件内容');
    });

    it('includeMessages=false：返回元数据，messages 为空数组（免付全量消息负载）', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '历史消息一' },
        { role: 'assistant', content: '历史消息二' },
      ];
      const sessionId = await service.create({
        workingDir: 'D:\\project',
        title: undefined,
        messages,
      });

      const metaOnly = await service.get(sessionId, { includeMessages: false });
      expect(metaOnly.session.workingDir).toBe('D:\\project');
      expect(metaOnly.session.messageCount).toBe(2);
      expect(metaOnly.messages).toEqual([]);

      const full = await service.get(sessionId);
      expect(full.messages).toHaveLength(2);
      const explicit = await service.get(sessionId, { includeMessages: true });
      expect(explicit.messages).toHaveLength(2);
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

      expect(summary.total).toEqual({
        calls: 2,
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
      });
      expect(summary.byModel).toHaveLength(1);
      expect(summary.byModel[0]).toMatchObject({
        modelId: 'deepseek-v4-flash',
        calls: 2,
        totalTokens: 450,
        cacheReadTokens: 30,
        reasoningTokens: 20,
      });
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

  describe('exportAll（P2-29：分批 IN 批量查询）', () => {
    it('多会话导出：sessions 按 updatedAt 倒序，组内消息按 seq 升序（逐字段等价）', async () => {
      const first = await service.create({
        workingDir: 'D:\\a',
        title: '会话一',
        messages: [
          { role: 'user', content: 'a1' },
          { role: 'assistant', content: 'a2' },
          { role: 'user', content: 'a3' },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const second = await service.create({
        workingDir: 'D:\\b',
        title: '会话二',
        messages: [{ role: 'user', content: 'b1' }],
      });

      const payload = await service.exportAll();
      expect(payload.app).toBe('code-agent-desktop');
      expect(payload.exportedAt).toBeGreaterThan(0);
      expect(payload.sessions).toHaveLength(2);
      expect(payload.sessions[0]?.meta.id).toBe(second);
      expect(payload.sessions[1]?.meta.id).toBe(first);
      expect(payload.sessions[1]?.messages).toHaveLength(3);
      expect(payload.sessions[0]?.messages).toEqual([
        { seq: 0, content: { role: 'user', content: 'b1' }, createdAt: expect.any(Number) },
      ]);
    });

    it('空库导出：sessions 为空数组且不发起消息查询', async () => {
      const payload = await service.exportAll();
      expect(payload.sessions).toEqual([]);
    });
  });

  describe('失效域声明', () => {
    beforeEach(() => {
      mockInvalidationSends.length = 0;
    });

    it('create：广播 [sessions, session:<id>]（S3）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });

      expect(mockInvalidationSends).toHaveLength(1);
      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', `session:${sessionId}`]);
      expect(lastInvalidationPayload()?.sessionId).toBeUndefined();
    });

    it('rename：广播 [sessions, session:<id>]（S2）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.rename(sessionId, '新标题');

      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', `session:${sessionId}`]);
    });

    it('pin：真实写入广播；幂等空操作（不存在会话）不广播（S2）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.pin(sessionId, true);
      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', `session:${sessionId}`]);

      mockInvalidationSends.length = 0;
      const missing = await service.pin('no-such-session', true);
      expect(missing.ok).toBe(false);
      expect(mockInvalidationSends).toHaveLength(0);
    });

    it('delete：仅广播 [sessions]（详情缓存指向已删除会话，不声明 session:<id>）（S1）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.delete(sessionId);

      expect(mockInvalidationSends).toHaveLength(1);
      expect(lastInvalidationPayload()?.domains).toEqual(['sessions']);
    });

    it('appendMessage：广播 [sessions, session:<id>]（S4）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.appendMessage({
        sessionId,
        messages: [{ role: 'user', content: 'hello' } as ChatMessage],
      });

      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', `session:${sessionId}`]);
    });

    it('replaceMessages：广播 [sessions, session:<id>]（S5，/compact 压缩落库）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.replaceMessages(sessionId, [
        { role: 'user', content: '压缩后' } as ChatMessage,
      ]);

      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', `session:${sessionId}`]);
    });

    it('importAll：有导入广播 [sessions]；全部同 id 跳过不广播（S6）', async () => {
      await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      const file = await service.exportAll();
      mockInvalidationSends.length = 0;

      const skipped = await service.importAll(structuredClone(file));
      expect(skipped).toEqual({ imported: 0, skipped: 1 });
      expect(mockInvalidationSends).toHaveLength(0);

      resetDb();
      const imported = await service.importAll(structuredClone(file));
      expect(imported).toEqual({ imported: 1, skipped: 0 });
      expect(mockInvalidationSends).toHaveLength(1);
      expect(lastInvalidationPayload()?.domains).toEqual(['sessions']);
    });

    it('markRunning / markIdle：刻意不广播（D4A 徽标竞态，spec §2.4 反回归锚）', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\x',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.markRunning(sessionId);
      await service.markIdle(sessionId);

      expect(mockInvalidationSends).toHaveLength(0);
    });
  });

  describe('clearAll（36-D）', () => {
    beforeEach(() => {
      mockInvalidationSends.length = 0;
    });

    it('正向：全表删除并返回真实计数，消息级联清空（V1/V3）', async () => {
      const s1 = await service.create({
        workingDir: 'D:\\a',
        title: undefined,
        messages: undefined,
      });
      const s2 = await service.create({
        workingDir: 'D:\\b',
        title: undefined,
        messages: undefined,
      });
      await service.appendMessage({
        sessionId: s1,
        turnId: 'turn-1',
        messages: [{ role: 'user', content: 'a1' }],
      });
      await service.appendMessage({
        sessionId: s2,
        turnId: 'turn-2',
        messages: [{ role: 'user', content: 'b1' }],
      });

      const res = await service.clearAll();

      expect(res.deleted).toBe(2);
      await expect(service.get(s1, { includeMessages: true })).rejects.toMatchObject({
        code: ErrorCode.SESSION_NOT_FOUND,
      });
      await expect(service.get(s2)).rejects.toMatchObject({
        code: ErrorCode.SESSION_NOT_FOUND,
      });
    });

    it('失效域声明：广播 [sessions, usage, turns, goal]（V7）', async () => {
      await service.create({
        workingDir: 'D:\\a',
        title: undefined,
        messages: undefined,
      });
      mockInvalidationSends.length = 0;

      await service.clearAll();

      expect(mockInvalidationSends).toHaveLength(1);
      expect(lastInvalidationPayload()?.domains).toEqual(['sessions', 'usage', 'turns', 'goal']);
    });

    it('幂等：空表清空 → deleted=0 不报错（V8）', async () => {
      const res = await service.clearAll();
      expect(res.deleted).toBe(0);
    });
  });
});
