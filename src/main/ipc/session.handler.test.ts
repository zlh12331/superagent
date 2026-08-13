// src/main/ipc/session.handler.test.ts
// session.handler 单测：12 个 session:* 方法的参数转发与错误路径（三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fake SessionService 经 deps 注入（handler 薄层：参数转发断言）
// - electron dialog/app 用 vi.mock 外壳（原生模块，允许 mock）
// - exportAll 三态：取消 / 成功写文件 / 写文件失败
// ──────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionHandlers, type SessionHandlerDeps } from './session.handler';

// hoisted：vi.mock 工厂提升先于模块级变量初始化，mock 函数需在 hoisted 块定义
const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => 'C:\\Users\\test\\Documents'),
  mockShowSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'C:\\out.json' })),
}));

vi.mock('electron', () => ({
  app: { getPath: mocks.mockGetPath },
  dialog: { showSaveDialog: mocks.mockShowSaveDialog },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn() };
});

/** fake SessionService：12 个方法全部可编程 */
function createFakeSessionService() {
  return {
    list: vi.fn(async () => ({ sessions: [], total: 0 })),
    get: vi.fn(async () => ({ session: null, messages: [] })),
    delete: vi.fn(async () => ({ deleted: true })),
    rename: vi.fn(async () => ({ renamed: true })),
    pin: vi.fn(async () => ({ pinned: true })),
    create: vi.fn(async () => 'sid-1'),
    listRecentDirs: vi.fn(async () => ({ dirs: [] })),
    exportAll: vi.fn(async () => ({ sessions: [], total: 0 })),
    getUsageSummary: vi.fn(async () => ({ totalTokens: 0, totalTurns: 0 })),
    getTurns: vi.fn(async () => ({ sessionId: '', turns: [] })),
    getRecentTurns: vi.fn(async () => ({ turns: [] })),
    getTurnMessages: vi.fn(async () => []),
    replaceMessages: vi.fn(async () => 0),
  } as unknown as SessionHandlerDeps['sessionService'];
}

/** 压缩器桩：默认恒等（removed=0），个别用例覆盖 */
function createFakeCompactMessages(): SessionHandlerDeps['compactMessages'] {
  return vi.fn((messages) => ({ trimmed: messages, removed: 0 }));
}

const EMPTY_CTX = {} as never;

describe('session.handler 参数转发（三件套）', () => {
  let sessionService: ReturnType<typeof createFakeSessionService>;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\out.json' });
    sessionService = createFakeSessionService();
    handlers = createSessionHandlers({
      sessionService,
      compactMessages: createFakeCompactMessages(),
    });
  });

  it('list：转发 limit/offset 分页参数', async () => {
    await handlers.list({ limit: 20, offset: 40 }, EMPTY_CTX);
    expect(sessionService.list).toHaveBeenCalledWith(20, 40);
  });

  it('get：转发 id', async () => {
    await handlers.get({ id: 's1' }, EMPTY_CTX);
    expect(sessionService.get).toHaveBeenCalledWith('s1');
  });

  it('delete：转发 id', async () => {
    await handlers.delete({ id: 's1' }, EMPTY_CTX);
    expect(sessionService.delete).toHaveBeenCalledWith('s1');
  });

  it('rename：转发 id + title', async () => {
    await handlers.rename({ id: 's1', title: '新标题' }, EMPTY_CTX);
    expect(sessionService.rename).toHaveBeenCalledWith('s1', '新标题');
  });

  it('pin：转发 id + pinned', async () => {
    await handlers.pin({ id: 's1', pinned: true }, EMPTY_CTX);
    expect(sessionService.pin).toHaveBeenCalledWith('s1', true);
    await handlers.pin({ id: 's1', pinned: false }, EMPTY_CTX);
    expect(sessionService.pin).toHaveBeenLastCalledWith('s1', false);
  });

  it('create：转发 workingDir/title，messages 不传（内部 API）', async () => {
    const res = await handlers.create({ workingDir: 'C:\\work', title: '会话' }, EMPTY_CTX);
    expect(sessionService.create).toHaveBeenCalledWith({
      workingDir: 'C:\\work',
      title: '会话',
      messages: undefined,
    });
    expect(res).toEqual({ sessionId: 'sid-1' });
  });

  it('listRecentDirs：转发 limit', async () => {
    await handlers.listRecentDirs({ limit: 5 }, EMPTY_CTX);
    expect(sessionService.listRecentDirs).toHaveBeenCalledWith({ limit: 5 });
  });

  it('getUsageSummary：无参转发', async () => {
    await handlers.getUsageSummary(undefined, EMPTY_CTX);
    expect(sessionService.getUsageSummary).toHaveBeenCalledTimes(1);
  });

  it('getTurns：转发 sessionId', async () => {
    await handlers.getTurns({ sessionId: 's1' }, EMPTY_CTX);
    expect(sessionService.getTurns).toHaveBeenCalledWith('s1');
  });

  it('getRecentTurns：转发 limit', async () => {
    await handlers.getRecentTurns({ limit: 10 }, EMPTY_CTX);
    expect(sessionService.getRecentTurns).toHaveBeenCalledWith({ limit: 10 });
  });

  it('getTurnMessages：转发 turnId + 返回 { messages }', async () => {
    vi.mocked(sessionService.getTurnMessages).mockResolvedValueOnce([
      { role: 'assistant', content: 'ok' } as never,
    ]);
    const res = await handlers.getTurnMessages({ turnId: 't1' }, EMPTY_CTX);
    expect(sessionService.getTurnMessages).toHaveBeenCalledWith('t1');
    expect(res).toEqual({ messages: [{ role: 'assistant', content: 'ok' }] });
  });

  it('异常：service 抛错 → 透传不包装', async () => {
    vi.mocked(sessionService.get).mockRejectedValueOnce(new Error('db down'));
    await expect(handlers.get({ id: 's1' }, EMPTY_CTX)).rejects.toThrow('db down');
  });
});

describe('session.handler.exportAll（三态）', () => {
  let sessionService: ReturnType<typeof createFakeSessionService>;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\out.json' });
    sessionService = createFakeSessionService();
    handlers = createSessionHandlers({
      sessionService,
      compactMessages: createFakeCompactMessages(),
    });
  });

  it('正向：选择路径 → exportAll + 写 JSON 文件 + 返回 saved/path', async () => {
    vi.mocked(sessionService.exportAll).mockResolvedValueOnce({
      sessions: [{ sessionId: 's1' } as never],
      total: 1,
    } as never);
    const res = await handlers.exportAll(undefined, EMPTY_CTX);
    expect(sessionService.exportAll).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledWith(
      'C:\\out.json',
      JSON.stringify({ sessions: [{ sessionId: 's1' }], total: 1 }, null, 2),
      'utf8',
    );
    expect(res).toEqual({ saved: true, path: 'C:\\out.json' });
  });

  it('边界：用户取消 → { saved: false } 不写文件', async () => {
    // exactOptionalPropertyTypes：filePath 类型必需——取消时传空串（handler 忽略）
    mocks.mockShowSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    const res = await handlers.exportAll(undefined, EMPTY_CTX);
    expect(res).toEqual({ saved: false });
    expect(sessionService.exportAll).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('边界：filePath 空串 → { saved: false }', async () => {
    mocks.mockShowSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' });
    const res = await handlers.exportAll(undefined, EMPTY_CTX);
    expect(res).toEqual({ saved: false });
  });

  it('异常：写文件失败 → 异常向上抛', async () => {
    const writeSpy = vi.mocked(writeFileSync);
    writeSpy.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    await expect(handlers.exportAll(undefined, EMPTY_CTX)).rejects.toThrow('EACCES');
  });
});

describe('session.handler.compact（/compact 上下文压缩）', () => {
  it('有裁剪：压缩器裁剪后 replaceMessages 落库 + 返回 removed/remaining/messages', async () => {
    const sessionService = createFakeSessionService();
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      session: { id: 's1' } as never,
      messages: [
        { role: 'user', content: '旧消息' },
        { role: 'user', content: '新消息' },
      ],
    } as never);
    const trimmed = [{ role: 'user', content: '新消息' }];
    const compactMessages = vi.fn(() => ({ trimmed, removed: 1 }));
    const handlers = createSessionHandlers({
      sessionService,
      compactMessages: compactMessages as unknown as SessionHandlerDeps['compactMessages'],
    });

    const res = await handlers.compact({ sessionId: 's1' }, EMPTY_CTX);

    expect(compactMessages).toHaveBeenCalledWith([
      { role: 'user', content: '旧消息' },
      { role: 'user', content: '新消息' },
    ]);
    expect(sessionService.replaceMessages).toHaveBeenCalledWith('s1', trimmed);
    expect(res).toEqual({ removed: 1, remaining: 1, messages: trimmed });
  });

  it('无裁剪（removed=0）：不落库，返回全量消息', async () => {
    const sessionService = createFakeSessionService();
    const messages = [{ role: 'user', content: '唯一消息' }];
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      session: { id: 's1' } as never,
      messages,
    } as never);
    const handlers = createSessionHandlers({
      sessionService,
      compactMessages: vi.fn(() => ({ trimmed: messages, removed: 0 })) as never,
    });

    const res = await handlers.compact({ sessionId: 's1' }, EMPTY_CTX);

    expect(sessionService.replaceMessages).not.toHaveBeenCalled();
    expect(res).toEqual({ removed: 0, remaining: 1, messages });
  });
});
