// src/main/infra/remote/remote-control.test.ts
// RemoteControlService 单测：令牌生成 / 校验路由 / 生命周期

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlService } from './remote-control';

describe('RemoteControlService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start：生成会话令牌并置运行态', async () => {
    const service = new RemoteControlService();
    const token = await service.start();
    expect(token.length).toBeGreaterThan(0);
    expect(service.isRunning()).toBe(true);
    expect(service.getSessionToken()).toBe(token);
  });

  it('start 幂等：重复调用返回同一令牌', async () => {
    const service = new RemoteControlService();
    const first = await service.start();
    const second = await service.start();
    expect(second).toBe(first);
  });

  it('stop：清令牌并退出运行态（可重入）', async () => {
    const service = new RemoteControlService();
    await service.start();
    await service.stop();
    expect(service.isRunning()).toBe(false);
    expect(service.getSessionToken()).toBeNull();
    await service.stop(); // 可重入 no-op
  });

  it('validateAndRoute：令牌匹配时路由到监听器', async () => {
    const service = new RemoteControlService();
    const token = await service.start();
    const handler = vi.fn(async () => true);
    service.onCommand(handler);

    const handled = await service.validateAndRoute({
      sessionToken: token,
      text: '查看状态',
      clientId: 'mobile-1',
    });
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '查看状态', clientId: 'mobile-1' }),
    );
  });

  it('validateAndRoute：令牌不匹配拒绝', async () => {
    const service = new RemoteControlService();
    await service.start();
    const handler = vi.fn(async () => true);
    service.onCommand(handler);

    const handled = await service.validateAndRoute({
      sessionToken: 'wrong-token',
      text: '危险命令',
      clientId: 'mobile-1',
    });
    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('validateAndRoute：未启动时拒绝', async () => {
    const service = new RemoteControlService();
    const handled = await service.validateAndRoute({
      sessionToken: 'any',
      text: 'x',
      clientId: 'm',
    });
    expect(handled).toBe(false);
  });
});
