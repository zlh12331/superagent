// src/main/ipc/handlers/chapter.handler.test.ts
// chapter.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock chapter.service 所有函数
// 3. 验证 register 函数注册了 6 个 channel
// 4. 验证每个 handler 回调正确调用对应 service 函数（含 reorder 的双参数传递）

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 wrap.test.ts）
const { registrations } = vi.hoisted(() => ({
  registrations: [] as WrapRegistration[],
}));

// mock wrap：捕获注册记录，不调用真实 ipcMain.handle
vi.mock('../../utils/wrap', () => ({
  wrap: (
    channel: string,
    schema: unknown,
    handler: (input: unknown, ctx: unknown) => Promise<unknown>,
  ) => {
    registrations.push({ channel, schema, handler });
  },
}));

// mock chapter.service：所有函数返回可识别的固定值
vi.mock('../../services/chapter.service', () => ({
  createChapter: vi.fn().mockResolvedValue({ id: 'c1', title: '第一章' }),
  listChapters: vi.fn().mockResolvedValue([{ id: 'c1', title: '第一章' }]),
  getChapter: vi.fn().mockResolvedValue({ id: 'c1', title: '第一章' }),
  updateChapter: vi.fn().mockResolvedValue({ id: 'c1', title: '更新后' }),
  reorderChapters: vi.fn().mockResolvedValue([
    { id: 'c2', sortOrder: 0 },
    { id: 'c1', sortOrder: 1 },
  ]),
  deleteChapter: vi.fn().mockResolvedValue({ id: 'c1' }),
}));

import {
  createChapter,
  deleteChapter,
  getChapter,
  listChapters,
  reorderChapters,
  updateChapter,
} from '../../services/chapter.service';
import { registerChapterHandlers } from './chapter.handler';

describe('chapter.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    registerChapterHandlers();
  });

  it('注册 6 个 channel', () => {
    expect(registrations).toHaveLength(6);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.CHAPTER_CREATE,
        IPC_CHANNELS.CHAPTER_LIST,
        IPC_CHANNELS.CHAPTER_GET,
        IPC_CHANNELS.CHAPTER_UPDATE,
        IPC_CHANNELS.CHAPTER_REORDER,
        IPC_CHANNELS.CHAPTER_DELETE,
      ]),
    );
  });

  it('create 透传 input 调用 createChapter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_CREATE).handler;
    const input = { projectId: 'p1', title: '第一章', content: '', status: 'DRAFT', sortOrder: 0 };
    const result = await handler(input, createMockCtx());
    expect(createChapter).toHaveBeenCalledWith(input);
    expect(result).toEqual({ id: 'c1', title: '第一章' });
  });

  it('list 从 input 提取 projectId 调用 listChapters', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_LIST).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(listChapters).toHaveBeenCalledWith('p1');
    expect(result).toEqual([{ id: 'c1', title: '第一章' }]);
  });

  it('get 从 input 提取 id 调用 getChapter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_GET).handler;
    await handler({ id: 'c1' }, createMockCtx());
    expect(getChapter).toHaveBeenCalledWith('c1');
  });

  it('update 透传 input 调用 updateChapter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_UPDATE).handler;
    const input = { id: 'c1', title: '新标题' };
    await handler(input, createMockCtx());
    expect(updateChapter).toHaveBeenCalledWith(input);
  });

  it('reorder 从 input 提取 projectId + orderedIds 调用 reorderChapters', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_REORDER).handler;
    const input = { projectId: 'p1', orderedIds: ['c2', 'c1'] };
    const result = await handler(input, createMockCtx());
    // 验证两个参数分别传递（projectId + orderedIds）
    expect(reorderChapters).toHaveBeenCalledWith('p1', ['c2', 'c1']);
    expect(result).toEqual([
      { id: 'c2', sortOrder: 0 },
      { id: 'c1', sortOrder: 1 },
    ]);
  });

  it('delete 从 input 提取 id 调用 deleteChapter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHAPTER_DELETE).handler;
    const result = await handler({ id: 'c1' }, createMockCtx());
    expect(deleteChapter).toHaveBeenCalledWith('c1');
    expect(result).toEqual({ id: 'c1' });
  });
});
