// src/main/infra/storage/session-io.test.ts
// 会话导出/导入存储层单测：round-trip 无损 / 冲突跳过 / 幂等 / 事务 / 格式校验
// ──────────────────────────────────────────────────────────────
// 测试策略（业务逻辑不 mock）：真实 SessionService + 内存 SQLite（走完整迁移，
// 含 UNIQUE/CHECK/外键约束），导出 → 换库 → 导入 → 再导出全量比对。
// 用量/回合时间戳取当下：getUsageSummary 有 90 天窗口过滤，历史时间戳会被排除。
// ──────────────────────────────────────────────────────────────

import type { SessionExportFile } from '@code-agent/shared/main';
import { ErrorCode } from '@code-agent/shared/main';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userdata'), isPackaged: false },
}));

import { getDb, resetDb } from './db';
import { sessions } from './schema';
import { SessionService } from './session-service';
import { createTestDb } from './test-utils';

// mock getDb 返回内存数据库（与 session-service.test.ts 同模式）
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  let memoryDb: ReturnType<typeof createTestDb> | null = null;

  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createTestDb();
      }
      return memoryDb.db;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

/** 用量/回合时间戳基准（当下：getUsageSummary 有 90 天窗口） */
const NOW = Date.now();

/** 构造合法的 version=1 导出文件（默认单会话；overrides 供构造非法变体） */
function buildExportFile(overrides?: {
  readonly version?: number;
  readonly sessions?: SessionExportFile['sessions'];
}) {
  const file: SessionExportFile = {
    version: 1,
    exportedAt: NOW - 60_000,
    app: 'code-agent-desktop',
    sessions: [
      {
        meta: {
          id: '11111111-1111-4111-8111-111111111111',
          title: '导入会话一',
          createdAt: NOW - 120_000,
          updatedAt: NOW - 100_000,
          lastMessage: '第二条',
          messageCount: 2,
          workingDir: 'D:\\proj',
          lastRunStatus: 'idle',
          pinned: false,
        },
        messages: [
          { seq: 0, content: { role: 'user', content: '第一条' }, createdAt: NOW - 120_000 },
          { seq: 1, content: { role: 'assistant', content: '第二条' }, createdAt: NOW - 110_000 },
        ],
        turns: [
          {
            turnId: 'turn-1',
            seq: 0,
            modelId: 'test-model',
            status: 'completed',
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: 120,
            durationMs: undefined,
            createdAt: NOW - 100_000,
          },
        ],
        usage: [
          {
            modelId: 'test-model',
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadTokens: undefined,
            reasoningTokens: undefined,
            createdAt: NOW - 100_000,
          },
        ],
      },
    ],
  };
  return { ...file, ...overrides };
}

describe('session-io 导出（version=1 文件格式）', () => {
  let service: SessionService;

  beforeEach(() => {
    resetDb();
    service = new SessionService();
  });

  it('正向：输出 version=1 + sessions 含 meta/messages/turns/usage 四段', async () => {
    const sessionId = await service.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: [
        { role: 'user', content: '帮我读取文件' },
        { role: 'assistant', content: '好的' },
      ],
    });
    await service.recordTurn({
      turnId: 'turn-abc',
      sessionId,
      seq: 0,
      modelId: 'test-model',
      status: 'completed',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 800,
    });
    await service.recordUsage({
      sessionId,
      modelId: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: undefined,
      reasoningTokens: undefined,
    });

    const payload = await service.exportAll();

    expect(payload.version).toBe(1);
    expect(payload.app).toBe('code-agent-desktop');
    expect(typeof payload.exportedAt).toBe('number');
    expect(payload.sessions).toHaveLength(1);
    const item = payload.sessions[0];
    expect(item?.meta.id).toBe(sessionId);
    expect(item?.meta.messageCount).toBe(2);
    expect(item?.messages).toHaveLength(2);
    expect(item?.messages[0]).toEqual({
      seq: 0,
      content: { role: 'user', content: '帮我读取文件' },
      createdAt: expect.any(Number),
    });
    expect(item?.turns[0]?.turnId).toBe('turn-abc');
    expect(item?.usage[0]?.totalTokens).toBe(15);
  });

  it('round-trip：导出 → 换库 → 导入 → 再导出，sessions 全量一致', async () => {
    const sessionId = await service.create({
      workingDir: 'D:\\proj',
      title: '带回合的会话',
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
      ],
    });
    await service.appendMessage({
      sessionId,
      messages: [{ role: 'user', content: '第二问' }],
      turnId: 'turn-rt-1',
    });
    await service.recordTurn({
      turnId: 'turn-rt-1',
      sessionId,
      seq: 0,
      modelId: 'test-model',
      status: 'completed',
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      durationMs: 10,
    });

    const first = await service.exportAll();
    const firstSessions = structuredClone(first.sessions);

    resetDb(); // 模拟换机：空库导入
    const res = await service.importAll(structuredClone(first));

    expect(res).toEqual({ imported: 1, skipped: 0 });
    const second = await service.exportAll();
    expect(second.sessions).toEqual(firstSessions);
  });
});

describe('session-io 导入（校验 / 冲突 / 幂等 / 事务）', () => {
  let service: SessionService;

  beforeEach(() => {
    resetDb();
    service = new SessionService();
  });

  it('校验：version 缺失 / 版本不匹配 / 非对象 → INVALID_INPUT，库零写入', async () => {
    for (const bad of [
      { exportedAt: 1, app: 'x', sessions: [] },
      { ...buildExportFile(), version: 2 },
      buildExportFile({ version: 0 }),
      'not-an-object',
      null,
      42,
    ]) {
      await expect(service.importAll(bad)).rejects.toMatchObject({
        code: ErrorCode.INVALID_INPUT,
      });
    }
    expect(getDb().select({ id: sessions.id }).from(sessions).all()).toEqual([]);
  });

  it('校验：会话条目缺关键字段（meta.workingDir）→ INVALID_INPUT', async () => {
    const file = buildExportFile();
    const item = file.sessions[0];
    if (item === undefined) throw new Error('测试数据缺失');
    // 故意构造缺字段的非法文件（unknown 逃逸类型检查）
    const bad: unknown = {
      ...file,
      sessions: [{ ...item, meta: { ...item.meta, workingDir: undefined } }],
    };
    await expect(service.importAll(bad)).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it('冲突：同 id 会话已存在 → 跳过并计数，已有会话数据不被触碰', async () => {
    const existingId = await service.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: [{ role: 'user', content: '本地已有消息' }],
    });
    // 同 id 但内容不同的导入条目
    const file = buildExportFile();
    const item = file.sessions[0];
    if (item === undefined) throw new Error('测试数据缺失');
    const conflict = { ...file, sessions: [{ ...item, meta: { ...item.meta, id: existingId } }] };

    const res = await service.importAll(conflict);

    expect(res).toEqual({ imported: 0, skipped: 1 });
    const detail = await service.get(existingId);
    expect(detail.messages).toHaveLength(1);
    expect(detail.session.title).toBe('本地已有消息');
  });

  it('幂等：同一文件二次导入 → 全部 skipped，消息/回合/用量不重复', async () => {
    const file = buildExportFile();
    const first = await service.importAll(structuredClone(file));
    expect(first).toEqual({ imported: 1, skipped: 0 });

    const second = await service.importAll(structuredClone(file));
    expect(second).toEqual({ imported: 0, skipped: 1 });

    const meta = file.sessions[0]?.meta;
    if (meta === undefined) throw new Error('测试数据缺失');
    const detail = await service.get(meta.id);
    expect(detail.messages).toHaveLength(2);
    const turnsRes = await service.getTurns(meta.id);
    expect(turnsRes.turns).toHaveLength(1);
    const usage = await service.getUsageSummary();
    expect(usage.total.calls).toBe(1);
  });

  it('事务：单会话文件内重复 seq（uq_messages_session_seq）→ 该会话回滚零残留，先导入的会话保留', async () => {
    const file = buildExportFile();
    const BadId = '22222222-2222-4222-8222-222222222222';
    const badSession: SessionExportFile['sessions'][number] = {
      meta: {
        id: BadId,
        title: '坏会话（重复 seq）',
        createdAt: NOW - 120_000,
        updatedAt: NOW - 100_000,
        lastMessage: undefined,
        messageCount: 2,
        workingDir: 'D:\\proj',
        lastRunStatus: 'idle',
        pinned: false,
      },
      messages: [
        { seq: 0, content: { role: 'user', content: 'a' }, createdAt: NOW - 120_000 },
        { seq: 0, content: { role: 'user', content: 'b' }, createdAt: NOW - 119_000 },
      ],
      turns: [],
      usage: [],
    };
    const good = file.sessions[0];
    if (good === undefined) throw new Error('测试数据缺失');
    // 好会话在前：其独立事务已提交；坏会话在后：抛错中止后续导入
    // （契约只有 imported/skipped，无失败计数——出错即中止并上抛，重导幂等收敛）
    const mixed = { ...file, sessions: [good, badSession] };

    await expect(service.importAll(mixed)).rejects.toBeInstanceOf(Error);

    // 坏会话：事务回滚，sessions 零残留
    const badRows = getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, BadId))
      .all();
    expect(badRows).toEqual([]);
    // 好会话：独立事务已提交
    const detail = await service.get(good.meta.id);
    expect(detail.messages).toHaveLength(2);
  });

  it('uq_turns_turn_id：同文件两会话携带同 turnId → 先到先得，后到会话跳过该回合但仍导入', async () => {
    const file = buildExportFile();
    const item = file.sessions[0];
    if (item === undefined) throw new Error('测试数据缺失');
    const SecondId = '33333333-3333-4333-8333-333333333333';
    const secondSession: SessionExportFile['sessions'][number] = {
      meta: { ...item.meta, id: SecondId, title: '第二会话' },
      messages: [],
      turns: item.turns,
      usage: [],
    };
    const res = await service.importAll({ ...file, sessions: [item, secondSession] });

    expect(res).toEqual({ imported: 2, skipped: 0 });
    const firstTurns = await service.getTurns(item.meta.id);
    expect(firstTurns.turns).toHaveLength(1);
    const secondTurns = await service.getTurns(SecondId);
    expect(secondTurns.turns).toHaveLength(0);
  });

  it('损坏消息：content 为不可解析字符串 → 跳过该条（warn），其余消息正常导入', async () => {
    const file = buildExportFile();
    const item = file.sessions[0];
    if (item === undefined) throw new Error('测试数据缺失');
    const withCorrupt = {
      ...file,
      sessions: [
        {
          ...item,
          messages: [
            ...item.messages,
            { seq: 2, content: 'corrupt-not-json{', createdAt: NOW - 90_000 },
          ],
        },
      ],
    };

    const res = await service.importAll(withCorrupt);

    expect(res).toEqual({ imported: 1, skipped: 0 });
    const detail = await service.get(item.meta.id);
    expect(detail.messages).toHaveLength(2);
    // messageCount 以实际入库条数为准（自洽）
    expect(detail.session.messageCount).toBe(2);
  });
});
