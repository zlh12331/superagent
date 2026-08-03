// src/main/ipc/session.handler.test.ts
// session.handler 单测：6 个方法转发（fake SessionService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionHandlers, type SessionHandlerDeps } from './session.handler';

/** 创建 fake SessionService */
function createFakeSessionService() {
  return {
    list: vi.fn(async () => ({ sessions: [], total: 0 })),
    get: vi.fn(async () => ({ session: null })),
    delete: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ ok: true })),
    create: vi.fn(async () => 'session-new'),
    listRecentDirs: vi.fn(async () => ({ dirs: [] })),
  } as unknown as SessionHandlerDeps['sessionService'];
}

const EMPTY_CTX = {} as never;

describe('session.handler', () => {
  let sessionService: ReturnType<typeof createFakeSessionService>;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionService = createFakeSessionService();
    handlers = createSessionHandlers({ sessionService });
  });

  it('list：转发 limit/offset', async () => {
    await handlers.list({ limit: 50, offset: 0 }, EMPTY_CTX);
    expect(sessionService.list).toHaveBeenCalledWith(50, 0);
  });

  it('get：转发 id', async () => {
    await handlers.get({ id: 's1' }, EMPTY_CTX);
    expect(sessionService.get).toHaveBeenCalledWith('s1');
  });

  it('delete：转发 id', async () => {
    await handlers.delete({ id: 's1' }, EMPTY_CTX);
    expect(sessionService.delete).toHaveBeenCalledWith('s1');
  });

  it('rename：转发 id/title', async () => {
    await handlers.rename({ id: 's1', title: '新标题' }, EMPTY_CTX);
    expect(sessionService.rename).toHaveBeenCalledWith('s1', '新标题');
  });

  it('create：转发 workingDir/title 并返回 sessionId', async () => {
    const result = await handlers.create({ workingDir: '/tmp/p', title: 't' }, EMPTY_CTX);
    expect(sessionService.create).toHaveBeenCalledWith({
      workingDir: '/tmp/p',
      title: 't',
      messages: undefined,
    });
    expect(result.sessionId).toBe('session-new');
  });

  it('listRecentDirs：转发 limit', async () => {
    await handlers.listRecentDirs({ limit: 5 }, EMPTY_CTX);
    expect(sessionService.listRecentDirs).toHaveBeenCalledWith({ limit: 5 });
  });
});
