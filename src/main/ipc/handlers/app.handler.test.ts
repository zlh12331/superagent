// src/main/ipc/handlers/app.handler.test.ts
// app.handler 单元测试
// 设计文档 §4.1 分层架构 / §7.9 健康监控
//
// 测试策略：
// 1. mock wrap：捕获注册的 channel + schema + handler
// 2. mock electron（shell.openExternal）
// 3. mock getPgController / getOllamaController / testPrismaConnection
// 4. getStatus 测试：验证返回结构（pgStatus / ollamaStatus / ollamaModelReady / dbConnected）
// 5. openExternal 测试：验证 shell.openExternal 被调用 + 返回 { ok: true }

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted：将 mock 容器提升到文件顶部，避免 vi.mock 工厂内引用触发 TDZ
const {
  registrations,
  mockShellOpenExternal,
  mockGetPgController,
  mockPgController,
  mockGetOllamaController,
  mockOllamaController,
  mockTestPrismaConnection,
} = vi.hoisted(() => ({
  // wrap 注册记录数组
  registrations: [] as WrapRegistration[],
  // electron shell.openExternal mock
  mockShellOpenExternal: vi.fn().mockResolvedValue(undefined),
  // getPgController mock（vi.fn 便于测试中切换 null / 实例）
  mockGetPgController: vi.fn(),
  // PgController 实例 mock（默认 getStatus 返回 'running'）
  mockPgController: {
    getStatus: vi.fn().mockReturnValue('running'),
  },
  // getOllamaController mock（vi.fn 便于测试中切换实例）
  mockGetOllamaController: vi.fn(),
  // OllamaController 实例 mock（默认 getStatus 返回 'stopped'）
  mockOllamaController: {
    getStatus: vi.fn().mockReturnValue('stopped'),
    getEmbedModel: vi.fn().mockReturnValue('test-model'),
  },
  // testPrismaConnection mock
  mockTestPrismaConnection: vi.fn().mockResolvedValue(true),
}));

// mock wrap：拦截注册调用，记录到 registrations
vi.mock('../../utils/wrap', () => ({
  wrap: (
    channel: string,
    schema: unknown,
    handler: (input: unknown, ctx: unknown) => Promise<unknown>,
  ) => {
    registrations.push({ channel, schema, handler });
  },
}));

// mock electron：仅暴露 shell.openExternal
vi.mock('electron', () => ({
  shell: {
    openExternal: mockShellOpenExternal,
  },
}));

// mock db-init：getPgController 替换为 vi.fn（便于切换 null / 实例）
vi.mock('../../app/db-init', () => ({
  getPgController: mockGetPgController,
}));

// mock ollama-controller：getOllamaController 替换为 vi.fn
vi.mock('../../infra/ai/ollama-controller', () => ({
  getOllamaController: mockGetOllamaController,
}));

// mock prisma/client：testPrismaConnection 替换为 vi.fn
vi.mock('../../infra/prisma/client', () => ({
  testPrismaConnection: mockTestPrismaConnection,
}));

import { registerAppHandlers } from './app.handler';

describe('app.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    vi.clearAllMocks();
    // 重新设置默认 mock 返回值（clearAllMocks 会清空）
    mockShellOpenExternal.mockResolvedValue(undefined);
    mockPgController.getStatus.mockReturnValue('running');
    mockOllamaController.getStatus.mockReturnValue('stopped');
    mockOllamaController.getEmbedModel.mockReturnValue('test-model');
    // 默认：pg / ollama 实例存在
    mockGetPgController.mockReturnValue(mockPgController);
    mockGetOllamaController.mockReturnValue(mockOllamaController);
    mockTestPrismaConnection.mockResolvedValue(true);
    registerAppHandlers();
  });

  it('应注册 2 个 channel', () => {
    const channels = registrations.map((r) => r.channel);
    expect(channels).toEqual([IPC_CHANNELS.APP_GET_STATUS, IPC_CHANNELS.APP_OPEN_EXTERNAL]);
  });

  describe('app:getStatus', () => {
    it('应返回完整状态结构（pgStatus / ollamaStatus / ollamaModelReady / dbConnected）', async () => {
      const handler = findRegistration(registrations, IPC_CHANNELS.APP_GET_STATUS).handler;
      const result = await handler(undefined, createMockCtx());

      // 验证返回结构（与 AppStatus 接口一致）
      expect(result).toEqual({
        pgStatus: 'running',
        ollamaStatus: 'stopped',
        ollamaModelReady: false,
        dbConnected: true,
      });

      // 验证调用了 pgController.getStatus / ollamaController.getStatus / testPrismaConnection
      expect(mockPgController.getStatus).toHaveBeenCalled();
      expect(mockOllamaController.getStatus).toHaveBeenCalled();
      expect(mockTestPrismaConnection).toHaveBeenCalled();
    });

    it('pg 未初始化时 pgStatus 应为 stopped', async () => {
      // getPgController 返回 null（应用启动早期 / PG 未初始化场景）
      mockGetPgController.mockReturnValue(null);

      const handler = findRegistration(registrations, IPC_CHANNELS.APP_GET_STATUS).handler;
      const result = await handler(undefined, createMockCtx());

      expect(result).toMatchObject({ pgStatus: 'stopped' });
    });

    it('testPrismaConnection 失败时 dbConnected 应为 false（不抛错）', async () => {
      mockTestPrismaConnection.mockRejectedValue(new Error('DB 连接失败'));

      const handler = findRegistration(registrations, IPC_CHANNELS.APP_GET_STATUS).handler;
      const result = await handler(undefined, createMockCtx());

      expect(result).toMatchObject({ dbConnected: false });
    });
  });

  describe('app:openExternal', () => {
    it('应调用 shell.openExternal 并返回 { ok: true }', async () => {
      const input = { url: 'https://github.com' };

      const handler = findRegistration(registrations, IPC_CHANNELS.APP_OPEN_EXTERNAL).handler;
      const result = await handler(input, createMockCtx());

      expect(mockShellOpenExternal).toHaveBeenCalledWith('https://github.com');
      expect(result).toEqual({ ok: true });
    });

    it('http 协议也应被允许', async () => {
      const input = { url: 'http://localhost:3000' };

      const handler = findRegistration(registrations, IPC_CHANNELS.APP_OPEN_EXTERNAL).handler;
      const result = await handler(input, createMockCtx());

      expect(mockShellOpenExternal).toHaveBeenCalledWith('http://localhost:3000');
      expect(result).toEqual({ ok: true });
    });
  });
});
