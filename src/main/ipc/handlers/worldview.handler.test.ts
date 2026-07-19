// src/main/ipc/handlers/worldview.handler.test.ts
// worldview.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
// §6.2 Worldview 模型：自关联树形，service 返回扁平数组
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock worldview.service 所有函数
// 3. 验证 register 函数注册了 4 个 channel
// 4. 验证每个 handler 回调正确调用对应 service 函数

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

// mock worldview.service：所有函数返回可识别的固定值
vi.mock('../../services/worldview.service', () => ({
  createWorldview: vi.fn().mockResolvedValue({ id: 'w1', title: '大陆' }),
  getWorldviewTree: vi.fn().mockResolvedValue([
    { id: 'w1', title: '大陆', parentId: null },
    { id: 'w2', title: '国家', parentId: 'w1' },
  ]),
  updateWorldview: vi.fn().mockResolvedValue({ id: 'w1', title: '更新后' }),
  deleteWorldview: vi.fn().mockResolvedValue({ id: 'w1' }),
}));

import {
  createWorldview,
  deleteWorldview,
  getWorldviewTree,
  updateWorldview,
} from '../../services/worldview.service';
import { registerWorldviewHandlers } from './worldview.handler';

describe('worldview.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    registerWorldviewHandlers();
  });

  it('注册 4 个 channel', () => {
    expect(registrations).toHaveLength(4);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.WORLDVIEW_CREATE,
        IPC_CHANNELS.WORLDVIEW_TREE,
        IPC_CHANNELS.WORLDVIEW_UPDATE,
        IPC_CHANNELS.WORLDVIEW_DELETE,
      ]),
    );
  });

  it('create 透传 input 调用 createWorldview', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.WORLDVIEW_CREATE).handler;
    const input = { projectId: 'p1', title: '大陆', sortOrder: 0 };
    const result = await handler(input, createMockCtx());
    expect(createWorldview).toHaveBeenCalledWith(input);
    expect(result).toEqual({ id: 'w1', title: '大陆' });
  });

  it('tree 从 input 提取 projectId 调用 getWorldviewTree', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.WORLDVIEW_TREE).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(getWorldviewTree).toHaveBeenCalledWith('p1');
    expect(result).toEqual([
      { id: 'w1', title: '大陆', parentId: null },
      { id: 'w2', title: '国家', parentId: 'w1' },
    ]);
  });

  it('update 透传 input 调用 updateWorldview', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.WORLDVIEW_UPDATE).handler;
    const input = { id: 'w1', title: '新标题' };
    await handler(input, createMockCtx());
    expect(updateWorldview).toHaveBeenCalledWith(input);
  });

  it('delete 从 input 提取 id 调用 deleteWorldview', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.WORLDVIEW_DELETE).handler;
    const result = await handler({ id: 'w1' }, createMockCtx());
    expect(deleteWorldview).toHaveBeenCalledWith('w1');
    expect(result).toEqual({ id: 'w1' });
  });
});
