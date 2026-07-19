// src/main/ipc/handlers/character.handler.test.ts
// character.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
// §6.3 AGE 图：addRelation/getRelations 涉及图边管理
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock character.service 所有函数
// 3. 验证 register 函数注册了 6 个 channel
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

// mock character.service：所有函数返回可识别的固定值
vi.mock('../../services/character.service', () => ({
  createCharacter: vi.fn().mockResolvedValue({ id: 'ch1', name: '主角' }),
  listCharacters: vi.fn().mockResolvedValue([{ id: 'ch1', name: '主角' }]),
  updateCharacter: vi.fn().mockResolvedValue({ id: 'ch1', name: '更新后' }),
  deleteCharacter: vi.fn().mockResolvedValue({ id: 'ch1' }),
  addCharacterRelation: vi.fn().mockResolvedValue({
    fromCharacterId: 'ch1',
    toCharacterId: 'ch2',
    type: '朋友',
  }),
  getCharacterRelations: vi
    .fn()
    .mockResolvedValue([{ fromCharacterId: 'ch1', toCharacterId: 'ch2', type: '朋友' }]),
}));

import {
  addCharacterRelation,
  createCharacter,
  deleteCharacter,
  getCharacterRelations,
  listCharacters,
  updateCharacter,
} from '../../services/character.service';
import { registerCharacterHandlers } from './character.handler';

describe('character.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    registerCharacterHandlers();
  });

  it('注册 6 个 channel', () => {
    expect(registrations).toHaveLength(6);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.CHARACTER_CREATE,
        IPC_CHANNELS.CHARACTER_LIST,
        IPC_CHANNELS.CHARACTER_UPDATE,
        IPC_CHANNELS.CHARACTER_DELETE,
        IPC_CHANNELS.CHARACTER_GET_RELATIONS,
        IPC_CHANNELS.CHARACTER_ADD_RELATION,
      ]),
    );
  });

  it('create 透传 input 调用 createCharacter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_CREATE).handler;
    const input = {
      projectId: 'p1',
      name: '主角',
      role: 'PROTAGONIST',
    };
    const result = await handler(input, createMockCtx());
    expect(createCharacter).toHaveBeenCalledWith(input);
    expect(result).toEqual({ id: 'ch1', name: '主角' });
  });

  it('list 从 input 提取 projectId 调用 listCharacters', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_LIST).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(listCharacters).toHaveBeenCalledWith('p1');
    expect(result).toEqual([{ id: 'ch1', name: '主角' }]);
  });

  it('update 透传 input 调用 updateCharacter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_UPDATE).handler;
    const input = { id: 'ch1', name: '新名字' };
    await handler(input, createMockCtx());
    expect(updateCharacter).toHaveBeenCalledWith(input);
  });

  it('delete 从 input 提取 id 调用 deleteCharacter', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_DELETE).handler;
    const result = await handler({ id: 'ch1' }, createMockCtx());
    expect(deleteCharacter).toHaveBeenCalledWith('ch1');
    expect(result).toEqual({ id: 'ch1' });
  });

  it('getRelations 从 input 提取 projectId 调用 getCharacterRelations', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_GET_RELATIONS).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(getCharacterRelations).toHaveBeenCalledWith('p1');
    expect(result).toEqual([{ fromCharacterId: 'ch1', toCharacterId: 'ch2', type: '朋友' }]);
  });

  it('addRelation 透传 input 调用 addCharacterRelation', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.CHARACTER_ADD_RELATION).handler;
    const input = {
      fromCharacterId: 'ch1',
      toCharacterId: 'ch2',
      type: '朋友',
    };
    const result = await handler(input, createMockCtx());
    expect(addCharacterRelation).toHaveBeenCalledWith(input);
    expect(result).toEqual({
      fromCharacterId: 'ch1',
      toCharacterId: 'ch2',
      type: '朋友',
    });
  });
});
