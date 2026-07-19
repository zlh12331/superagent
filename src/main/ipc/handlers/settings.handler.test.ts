// src/main/ipc/handlers/settings.handler.test.ts
// settings.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
// §6.2 ProjectSetting / §1.2 决策 5 API Key 存 keychain
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock settings.service 所有函数
// 3. 验证 register 函数注册了 4 个 channel
// 4. 验证每个 handler 回调正确调用对应 service 函数
//    特别地：setApiKey 需验证 provider + apiKey 双参数传递
//    testApiKey 需验证 provider 单参数传递

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

// mock settings.service：所有函数返回可识别的固定值
vi.mock('../../services/settings.service', () => ({
  getProjectSettings: vi.fn().mockResolvedValue({
    projectId: 'p1',
    aiModel: 'deepseek-v4-flash',
    aiTemperature: 0.7,
    aiMaxTokens: 4096,
    ragEnabled: true,
    ragTopK: 5,
    ragThreshold: 0.7,
    customPrompts: {},
    updatedAt: '2026-07-19T00:00:00.000Z',
  }),
  updateProjectSettings: vi.fn().mockResolvedValue({
    projectId: 'p1',
    aiModel: 'deepseek-v4-flash',
    aiTemperature: 0.5,
    aiMaxTokens: 4096,
    ragEnabled: true,
    ragTopK: 5,
    ragThreshold: 0.7,
    customPrompts: {},
    updatedAt: '2026-07-19T00:00:00.000Z',
  }),
  setApiKey: vi.fn().mockResolvedValue({ ok: true }),
  testApiKey: vi.fn().mockResolvedValue({ ok: true, latencyMs: 120 }),
}));

import {
  getProjectSettings,
  setApiKey,
  testApiKey,
  updateProjectSettings,
} from '../../services/settings.service';
import { registerSettingsHandlers } from './settings.handler';

describe('settings.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    registerSettingsHandlers();
  });

  it('注册 4 个 channel', () => {
    expect(registrations).toHaveLength(4);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.SETTINGS_GET,
        IPC_CHANNELS.SETTINGS_SET,
        IPC_CHANNELS.SETTINGS_SET_API_KEY,
        IPC_CHANNELS.SETTINGS_TEST_API_KEY,
      ]),
    );
  });

  it('get 从 input 提取 projectId 调用 getProjectSettings', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.SETTINGS_GET).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(getProjectSettings).toHaveBeenCalledWith('p1');
    expect(result).toEqual(
      expect.objectContaining({ projectId: 'p1', aiModel: 'deepseek-v4-flash' }),
    );
  });

  it('set 透传 input 调用 updateProjectSettings', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.SETTINGS_SET).handler;
    const input = { projectId: 'p1', aiTemperature: 0.5 };
    await handler(input, createMockCtx());
    expect(updateProjectSettings).toHaveBeenCalledWith(input);
  });

  it('setApiKey 从 input 提取 provider + apiKey 调用 setApiKey', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.SETTINGS_SET_API_KEY).handler;
    const input = { provider: 'deepseek' as const, apiKey: 'sk-xxx' };
    const result = await handler(input, createMockCtx());
    // 验证两个参数分别传递（provider + apiKey）
    expect(setApiKey).toHaveBeenCalledWith('deepseek', 'sk-xxx');
    expect(result).toEqual({ ok: true });
  });

  it('testApiKey 从 input 提取 provider 调用 testApiKey', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.SETTINGS_TEST_API_KEY).handler;
    const input = { provider: 'ollama' as const };
    const result = await handler(input, createMockCtx());
    expect(testApiKey).toHaveBeenCalledWith('ollama');
    expect(result).toEqual({ ok: true, latencyMs: 120 });
  });
});
