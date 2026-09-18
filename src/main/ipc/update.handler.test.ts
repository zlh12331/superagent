// src/main/ipc/update.handler.test.ts
// update.handler 单测：check/install/cancel/getStatus 转发（fake UpdateService DI 注入）
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUpdateHandlers, type UpdateHandlerDeps } from './update.handler';

/** 创建 fake UpdateService */
function createFakeUpdateService() {
  return {
    start: vi.fn(),
    check: vi.fn(async () => ({ status: 'checking' as const })),
    cancelDownload: vi.fn(),
    getStatus: vi.fn(() => ({ snapshot: null, lastCheckAt: null })),
    quitAndInstall: vi.fn(),
    dispose: vi.fn(),
  } as unknown as UpdateHandlerDeps['updateService'] & {
    check: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    cancelDownload: ReturnType<typeof vi.fn>;
  };
}

const EMPTY_CTX = {} as never;

describe('update.handler', () => {
  let updateService: ReturnType<typeof createFakeUpdateService>;
  let handlers: ReturnType<typeof createUpdateHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    updateService = createFakeUpdateService();
    handlers = createUpdateHandlers({ updateService });
  });

  it('check：转发 manual 参数', async () => {
    await handlers.check({ manual: true }, EMPTY_CTX);
    expect(updateService.check).toHaveBeenCalledWith(true);
  });

  it('check：manual 缺省为 false', async () => {
    await handlers.check({}, EMPTY_CTX);
    expect(updateService.check).toHaveBeenCalledWith(false);
  });

  it('check：透传服务返回值', async () => {
    updateService.check.mockResolvedValueOnce({ status: 'error', message: 'boom' });
    const result = await handlers.check({ manual: false }, EMPTY_CTX);
    expect(result).toEqual({ status: 'error', message: 'boom' });
  });

  it('install：调用 quitAndInstall 并返回 ok', async () => {
    const result = await handlers.install(undefined, EMPTY_CTX);
    expect(updateService.quitAndInstall).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });

  it('cancel：调用 cancelDownload 并返回 ok', async () => {
    const result = await handlers.cancel(undefined, EMPTY_CTX);
    expect(updateService.cancelDownload).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });

  it('getStatus：透传服务快照与上次检查时间', async () => {
    const result = await handlers.getStatus(undefined, EMPTY_CTX);
    expect(result).toEqual({ snapshot: null, lastCheckAt: null });
  });

  it('getStatus：透传服务快照', async () => {
    updateService.getStatus.mockReturnValueOnce({
      snapshot: { phase: 'downloaded', version: '1.2.0' },
      lastCheckAt: 1_700_000_000_000,
    });
    const result = await handlers.getStatus(undefined, EMPTY_CTX);
    expect(result).toEqual({
      snapshot: { phase: 'downloaded', version: '1.2.0' },
      lastCheckAt: 1_700_000_000_000,
    });
  });
});
