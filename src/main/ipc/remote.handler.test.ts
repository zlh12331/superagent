// src/main/ipc/remote.handler.test.ts
// remote 域 handler 单测：状态快照组装（启停后回读 / 未运行清空 / 异常态降级）
// ──────────────────────────────────────────────────────────────
// 传输服务与局域网枚举均为注入 fake（网络地址是环境相关，必须桩化才稳定）。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { IRemoteControlService } from '../infra/remote/remote-control';
import type { IpcHandlerContext } from '../utils/wrap';
import { createRemoteHandlers } from './remote.handler';

/** 构造可控状态的假传输服务 */
function fakeService(state: {
  running: boolean;
  port: number | null;
  token: string | null;
  activeCommands?: number;
  lastCommandAt?: number | null;
}) {
  const start = vi.fn(async () => {
    state.running = true;
    state.port = 45918;
    state.token = 'token-1';
    return 'token-1';
  });
  const stop = vi.fn(async () => {
    state.running = false;
    state.port = null;
    state.token = null;
  });
  const service: IRemoteControlService = {
    start,
    stop,
    isRunning: () => state.running,
    getSessionToken: () => state.token,
    getPort: () => state.port,
    getInstanceName: () => 'dev-desktop',
    getActivity: () => ({
      activeCommands: state.activeCommands ?? 0,
      lastCommandAt: state.lastCommandAt ?? null,
    }),
    onCommand: () => () => {},
    validateAndRoute: async () => ({ accepted: false }),
  };
  return { service, start, stop };
}

/** 地址枚举桩（固定网卡，避免测试依赖真实网络环境） */
const network = {
  listAddresses: () => ['192.168.1.10', '10.0.0.5'],
  buildEndpoints: (addresses: readonly string[], port: number) =>
    addresses.map((address) => `http://${address}:${port}`),
};

function ctx(): IpcHandlerContext {
  return { sender: {} as never, traceId: 'trace-remote' };
}

describe('remote handler', () => {
  it('getStatus：未运行时端口/令牌/地址一律为空', async () => {
    const { service } = fakeService({ running: false, port: null, token: null });
    const handlers = createRemoteHandlers({ remoteControl: service, network });

    expect(await handlers.getStatus(undefined as never, ctx())).toEqual({
      running: false,
      port: null,
      token: null,
      instanceName: 'dev-desktop',
      addresses: [],
      activeCommands: 0,
      lastCommandAt: null,
    });
  });

  it('start：启动传输层后返回可配对快照（令牌 + 局域网端点）', async () => {
    const { service, start } = fakeService({ running: false, port: null, token: null });
    const handlers = createRemoteHandlers({ remoteControl: service, network });

    const res = await handlers.start(undefined as never, ctx());
    expect(start).toHaveBeenCalledTimes(1);
    expect(res.running).toBe(true);
    expect(res.token).toBe('token-1');
    expect(res.addresses).toEqual(['http://192.168.1.10:45918', 'http://10.0.0.5:45918']);
  });

  it('stop：快照即刻清空令牌与地址（面板不残留可配对凭据）', async () => {
    const { service, stop } = fakeService({
      running: true,
      port: 45918,
      token: 'token-1',
      activeCommands: 2,
      lastCommandAt: 123,
    });
    const handlers = createRemoteHandlers({ remoteControl: service, network });

    const before = await handlers.getStatus(undefined as never, ctx());
    expect(before).toMatchObject({ running: true, activeCommands: 2, lastCommandAt: 123 });

    const after = await handlers.stop(undefined as never, ctx());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(after).toMatchObject({ running: false, port: null, token: null, addresses: [] });
  });

  it('异常态降级：running 但端口/令牌缺失时不回传半截配对信息', async () => {
    const { service } = fakeService({ running: true, port: null, token: null });
    const handlers = createRemoteHandlers({ remoteControl: service, network });

    expect(await handlers.getStatus(undefined as never, ctx())).toMatchObject({
      running: true,
      port: null,
      token: null,
      addresses: [],
    });
  });
});
