// src/main/infra/remote/remote-control.test.ts
// RemoteControlService 单测：令牌生成 / 校验路由 / 生命周期 / HTTP 桥接 / 发现广播
// ──────────────────────────────────────────────────────────────
// 网络为真实边界（本机回环，无外部依赖）：HTTP 用 fetch 直连监听端口，
// 发现广播注入 127.0.0.1 单播（生产为全网广播；单播在 CI/防火墙环境稳定）。
// ──────────────────────────────────────────────────────────────

import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlService } from './remote-control';

/** 本用例启动的服务（afterEach 统一 stop，防端口/定时器残留） */
const activeServices: RemoteControlService[] = [];

async function startService(options?: ConstructorParameters<typeof RemoteControlService>[0]) {
  const service = new RemoteControlService(options);
  activeServices.push(service);
  const token = await service.start();
  return { service, token };
}

afterEach(async () => {
  while (activeServices.length > 0) {
    await activeServices.pop()?.stop();
  }
});

describe('RemoteControlService（生命周期与路由）', () => {
  it('start：生成会话令牌、置运行态并暴露 HTTP 端口', async () => {
    const { service, token } = await startService();
    expect(token.length).toBeGreaterThan(0);
    expect(service.isRunning()).toBe(true);
    expect(service.getSessionToken()).toBe(token);
    expect(service.getPort()).toBeGreaterThan(0);
  });

  it('start 幂等：重复调用返回同一令牌（不重复监听）', async () => {
    const { service, token } = await startService();
    const port = service.getPort();
    const second = await service.start();
    expect(second).toBe(token);
    expect(service.getPort()).toBe(port);
  });

  it('stop：清令牌/端口并退出运行态（可重入）', async () => {
    const service = new RemoteControlService();
    await service.start();
    await service.stop();
    expect(service.isRunning()).toBe(false);
    expect(service.getSessionToken()).toBeNull();
    expect(service.getPort()).toBeNull();
    await service.stop(); // 可重入 no-op
  });

  it('validateAndRoute：令牌匹配时路由到监听器', async () => {
    const { service, token } = await startService();
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
    const { service } = await startService();
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

describe('RemoteControlService（HTTP 桥接）', () => {
  const baseUrl = (service: RemoteControlService): string =>
    `http://127.0.0.1:${service.getPort()}`;

  it('GET /info：返回配对元数据（不含令牌）', async () => {
    const { service } = await startService({ instanceName: 'dev-desktop' });
    const res = await fetch(`${baseUrl(service)}/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: string;
      name: string;
      port: number | null;
      requiresToken: boolean;
    };
    expect(body.service).toBe('code-agent-remote');
    expect(body.name).toBe('dev-desktop');
    expect(body.port).toBe(service.getPort());
    expect(body.requiresToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain(service.getSessionToken() ?? '');
  });

  it('POST /command：令牌匹配 → 路由监听器并返回 accepted', async () => {
    const { service, token } = await startService();
    const handler = vi.fn(async () => true);
    service.onCommand(handler);

    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token, text: '运行测试', clientId: 'mobile-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '运行测试', clientId: 'mobile-1' }),
    );
  });

  it('POST /command：令牌不匹配 → 403（监听器不触发）', async () => {
    const { service } = await startService();
    const handler = vi.fn(async () => true);
    service.onCommand(handler);

    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: 'wrong', text: 'x', clientId: 'm' }),
    });
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('POST /command：字段缺失/超限 → 400；未知路径 → 404', async () => {
    const { service } = await startService();
    const missing = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      body: JSON.stringify({ text: '缺令牌' }),
    });
    expect(missing.status).toBe(400);

    const badJson = await fetch(`${baseUrl(service)}/command`, { method: 'POST', body: '{oops' });
    expect(badJson.status).toBe(400);

    const notFound = await fetch(`${baseUrl(service)}/other`);
    expect(notFound.status).toBe(404);
  });

  it('POST /command：超 64KB 请求体 → 413', async () => {
    const { service, token } = await startService();
    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      body: JSON.stringify({ sessionToken: token, text: 'x'.repeat(70 * 1024), clientId: 'm' }),
    });
    expect(res.status).toBe(413);
  });

  it('stop：HTTP 监听关闭（连接被拒）', async () => {
    const { service, token } = await startService();
    const url = `${baseUrl(service)}/command`;
    await service.stop();
    await expect(
      fetch(url, {
        method: 'POST',
        body: JSON.stringify({ sessionToken: token, text: 'x', clientId: 'm' }),
      }),
    ).rejects.toThrow();
  });
});

describe('RemoteControlService（局域网发现广播）', () => {
  it('start 后按间隔广播公告（service/name/port，不含令牌）', async () => {
    // 接收端：回环随机端口（单播注入，跨平台稳定）
    const receiver = createSocket({ type: 'udp4' });
    const discoveryPort = await new Promise<number>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.bind(0, '127.0.0.1', () => {
        resolve((receiver.address() as { port: number }).port);
      });
    });

    const { service, token } = await startService({
      discoveryPort,
      broadcastAddress: '127.0.0.1',
      broadcastIntervalMs: 30,
      instanceName: 'dev-desktop',
    });

    const packet = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('3s 内未收到发现公告')), 3000);
      receiver.once('message', (msg) => {
        clearTimeout(timer);
        resolve(msg.toString('utf8'));
      });
    });
    receiver.close();

    const announcement = JSON.parse(packet) as {
      service: string;
      version: number;
      name: string;
      port: number | null;
      protocol: string;
    };
    expect(announcement.service).toBe('code-agent-remote');
    expect(announcement.version).toBe(1);
    expect(announcement.name).toBe('dev-desktop');
    expect(announcement.protocol).toBe('http');
    expect(announcement.port).toBe(service.getPort());
    expect(packet).not.toContain(token);
  });
});
