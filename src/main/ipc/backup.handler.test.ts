// src/main/ipc/backup.handler.test.ts
// backup.handler 单测（37 号 B）：守卫与转发（三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略：backup-store 与 db 以 vi.mock 注入 fake（真实 fs 语义在
// backup-store.test.ts 覆盖）；此处只断言 handler 的守卫与转发契约。
// ──────────────────────────────────────────────────────────────

import type { BackupEntry } from '@code-agent/shared/main';
import { ErrorCode } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listBackups: vi.fn((): BackupEntry[] => []),
  stageRestore: vi.fn(),
  createManualBackup: vi.fn(async () => ({ name: 'sessions-x.db' })),
  getDbPath: vi.fn(() => 'C:\\data\\sessions.db'),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('../infra/storage/backup-store', () => ({
  listBackups: mocks.listBackups,
  stageRestore: mocks.stageRestore,
}));
vi.mock('../infra/storage/db', () => ({
  getDbPath: mocks.getDbPath,
  createManualBackup: mocks.createManualBackup,
}));
vi.mock('electron', () => ({
  app: { relaunch: mocks.relaunch, quit: mocks.quit },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createBackupHandlers } from './backup.handler';

const EMPTY_CTX = {} as never;

describe('backup.handler（37-B）', () => {
  let handlers: ReturnType<typeof createBackupHandlers>;
  /** 运行中回合守卫桩：beforeEach 复位 false，守卫用例改写 true */
  const hasRunningAgentTurns = vi.fn(() => false);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createManualBackup.mockResolvedValue({ name: 'sessions-x.db' });
    hasRunningAgentTurns.mockReturnValue(false);
    handlers = createBackupHandlers({
      hasRunningAgentTurns,
    });
  });

  it('list：转发 backup-store.listBackups 结果', async () => {
    const entries = [{ name: 'sessions-a.db', createdAtMs: 1, sizeBytes: 10, healthy: true }];
    mocks.listBackups.mockReturnValueOnce(entries);

    const res = await handlers.list(undefined, EMPTY_CTX);

    expect(res).toEqual({ backups: entries });
    expect(mocks.listBackups).toHaveBeenCalledWith('C:\\data\\sessions.db');
  });

  it('create：转发 createManualBackup 的 name', async () => {
    const res = await handlers.create(undefined, EMPTY_CTX);

    expect(res).toEqual({ name: 'sessions-x.db' });
    expect(mocks.createManualBackup).toHaveBeenCalledOnce();
  });

  it('restore：无运行中回合 → stageRestore + 延迟 relaunch/quit', async () => {
    const res = await handlers.restore({ name: 'sessions-a.db' }, EMPTY_CTX);

    expect(res).toEqual({ ok: true });
    expect(mocks.stageRestore).toHaveBeenCalledWith('C:\\data\\sessions.db', 'sessions-a.db');
    // relaunch/quit 在 setImmediate 中（先让 IPC ack 回渲染层）
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it('restore：有运行中回合 → SESSION_IN_USE 拒绝，不暂存不重启（V3）', async () => {
    hasRunningAgentTurns.mockReturnValue(true);

    await expect(handlers.restore({ name: 'sessions-a.db' }, EMPTY_CTX)).rejects.toMatchObject({
      code: ErrorCode.SESSION_IN_USE,
    });
    expect(mocks.stageRestore).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('restore：stageRestore 抛错（损坏/不存在）→ 异常上抛，不重启', async () => {
    mocks.stageRestore.mockImplementationOnce(() => {
      throw new Error('备份损坏，无法恢复');
    });

    await expect(handlers.restore({ name: 'sessions-a.db' }, EMPTY_CTX)).rejects.toThrow(
      '备份损坏',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
