// src/main/ipc/handlers/project.handler.test.ts
// project.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock project.service 所有函数
// 3. 验证 register 函数注册了正确数量的 channel
// 4. 验证每个 handler 回调正确调用对应 service 函数

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 wrap.test.ts）
// registrations 数组在 vi.mock 工厂内被引用，必须用 hoisted 提升
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

// mock project.service：所有函数返回可识别的固定值
vi.mock('../../services/project.service', () => ({
  createProject: vi.fn().mockResolvedValue({ id: 'p1', name: '测试项目' }),
  listProjects: vi.fn().mockResolvedValue([{ id: 'p1', name: '测试项目' }]),
  getProject: vi.fn().mockResolvedValue({ id: 'p1', name: '测试项目' }),
  updateProject: vi.fn().mockResolvedValue({ id: 'p1', name: '更新后' }),
  deleteProject: vi.fn().mockResolvedValue({ id: 'p1' }),
  archiveProject: vi.fn().mockResolvedValue({ id: 'p1', status: 'ARCHIVED' }),
}));

import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../../services/project.service';
import { registerProjectHandlers } from './project.handler';

describe('project.handler', () => {
  beforeEach(() => {
    // 重置注册记录，避免不同用例间污染
    registrations.length = 0;
    // 重新注册（每个用例都需要一个干净的 registrations 数组）
    registerProjectHandlers();
  });

  it('注册 6 个 channel', () => {
    expect(registrations).toHaveLength(6);
    // 验证关键 channel 都已注册
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.PROJECT_CREATE,
        IPC_CHANNELS.PROJECT_LIST,
        IPC_CHANNELS.PROJECT_GET,
        IPC_CHANNELS.PROJECT_UPDATE,
        IPC_CHANNELS.PROJECT_DELETE,
        IPC_CHANNELS.PROJECT_ARCHIVE,
      ]),
    );
  });

  it('create 透传 input 调用 createProject', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_CREATE).handler;
    const input = { name: '测试项目' };
    const result = await handler(input, createMockCtx());
    expect(createProject).toHaveBeenCalledWith(input);
    expect(result).toEqual({ id: 'p1', name: '测试项目' });
  });

  it('list 无入参调用 listProjects', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_LIST).handler;
    const result = await handler(undefined, createMockCtx());
    expect(listProjects).toHaveBeenCalledWith();
    expect(result).toEqual([{ id: 'p1', name: '测试项目' }]);
  });

  it('get 从 input 提取 id 调用 getProject', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_GET).handler;
    await handler({ id: 'p1' }, createMockCtx());
    expect(getProject).toHaveBeenCalledWith('p1');
  });

  it('update 透传 input 调用 updateProject', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_UPDATE).handler;
    const input = { id: 'p1', name: '新名称' };
    await handler(input, createMockCtx());
    expect(updateProject).toHaveBeenCalledWith(input);
  });

  it('delete 从 input 提取 id 调用 deleteProject', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_DELETE).handler;
    const result = await handler({ id: 'p1' }, createMockCtx());
    expect(deleteProject).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ id: 'p1' });
  });

  it('archive 从 input 提取 id 调用 archiveProject', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_ARCHIVE).handler;
    const result = await handler({ id: 'p1' }, createMockCtx());
    expect(archiveProject).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ id: 'p1', status: 'ARCHIVED' });
  });
});
