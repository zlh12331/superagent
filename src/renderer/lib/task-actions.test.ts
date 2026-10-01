// src/renderer/lib/task-actions.test.ts
// Task list IPC bridge: empty on no-bridge / success / unwrap failure

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from './ipc-factories';
import { fetchTaskList } from './task-actions';

function mockTaskApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['task'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('task-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('bridge success returns task list', async () => {
    const tasks = [
      { id: 't1', title: 'write tests', done: false },
      { id: 't2', title: 'backfill floors', done: true },
    ];
    mockTaskApi({ list: vi.fn(async () => ipcOk({ tasks })) });
    await expect(fetchTaskList('s-1')).resolves.toEqual({ tasks });
  });

  it('forwards sessionId when provided; omits when absent', async () => {
    const listMock = vi.fn(async () => ipcOk({ tasks: [] }));
    mockTaskApi({ list: listMock });
    await fetchTaskList('s-1');
    expect(listMock).toHaveBeenCalledWith({ sessionId: 's-1' });
    await fetchTaskList();
    expect(listMock).toHaveBeenCalledWith({});
  });

  it('no bridge returns empty list', async () => {
    removeBridge();
    await expect(fetchTaskList('s-1')).resolves.toEqual({ tasks: [] });
  });

  it('IPC error response throws [CODE]', async () => {
    mockTaskApi({ list: vi.fn(async () => ipcErr('TASK_LIST_FAILED', 'boom')) });
    await expect(fetchTaskList('s-1')).rejects.toThrow(/\[TASK_LIST_FAILED\]/);
  });
});
