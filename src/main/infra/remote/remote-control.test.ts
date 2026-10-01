// src/main/infra/remote/remote-control.test.ts
// RemoteControlService 单测：令牌生成 / 校验路由 / 生命周期 / HTTP 桥接 / 发现广播
// ──────────────────────────────────────────────────────────────
// 网络为真实边界（本机回环，无外部依赖）：HTTP 用 fetch 直连监听端口，
// 发现广播注入 127.0.0.1 单播（生产为全网广播；单播在 CI/防火墙环境稳定）。
// ──────────────────────────────────────────────────────────────

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type RemoteCommand,
  type RemoteCommandEmitter,
  RemoteControlService,
} from './remote-control';

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

  it('validateAndRoute：令牌匹配时路由到监听器并透出执行结果', async () => {
    const { service, token } = await startService();
    const handler = vi.fn(async () => ({ accepted: true, reply: '已完成' }));
    service.onCommand(handler);

    const routed = await service.validateAndRoute({
      sessionToken: token,
      text: '查看状态',
      clientId: 'mobile-1',
    });
    expect(routed).toEqual({ accepted: true, reply: '已完成' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '查看状态', clientId: 'mobile-1' }),
      expect.any(Function),
    );
  });

  it('validateAndRoute：令牌不匹配拒绝', async () => {
    const { service } = await startService();
    const handler = vi.fn(async () => ({ accepted: true }));
    service.onCommand(handler);

    const routed = await service.validateAndRoute({
      sessionToken: 'wrong-token',
      text: '危险命令',
      clientId: 'mobile-1',
    });
    expect(routed.accepted).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('validateAndRoute：未启动时拒绝', async () => {
    const service = new RemoteControlService();
    const routed = await service.validateAndRoute({
      sessionToken: 'any',
      text: 'x',
      clientId: 'm',
    });
    expect(routed).toEqual({ accepted: false });
  });

  it('getActivity：命令执行期间计数 +1，完成后归零并记录到达时间', async () => {
    const { service, token } = await startService();
    let releaseTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    service.onCommand(async () => {
      await turnDone;
      return { accepted: true, reply: 'ok' };
    });

    expect(service.getActivity()).toEqual({ activeCommands: 0, lastCommandAt: null });
    const inflight = service.validateAndRoute({
      sessionToken: token,
      text: '长任务',
      clientId: 'mobile-1',
    });
    await vi.waitFor(() => expect(service.getActivity().activeCommands).toBe(1));
    expect(service.getActivity().lastCommandAt).toBeTypeOf('number');

    releaseTurn();
    await inflight;
    expect(service.getActivity().activeCommands).toBe(0);
  });

  it('stop 保留命令订阅：关闭再开启后命令仍能被桥接接管', async () => {
    const service = new RemoteControlService();
    activeServices.push(service);
    const handler = vi.fn(async () => ({ accepted: true, reply: 'ok' }));
    service.onCommand(handler);

    await service.start();
    await service.stop();
    const token = await service.start();

    const routed = await service.validateAndRoute({
      sessionToken: token,
      text: '重连后的命令',
      clientId: 'mobile-1',
    });
    expect(routed).toEqual({ accepted: true, reply: 'ok' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('start 归零活动计数（新配对话轮不残留上一轮状态）', async () => {
    const service = new RemoteControlService();
    activeServices.push(service);
    service.onCommand(async () => ({ accepted: true }));
    const first = await service.start();
    await service.validateAndRoute({ sessionToken: first, text: 'a', clientId: 'm' });
    expect(service.getActivity().lastCommandAt).not.toBeNull();

    await service.stop();
    await service.start();
    expect(service.getActivity()).toEqual({ activeCommands: 0, lastCommandAt: null });
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

  it('POST /command：令牌匹配 → 同步回传桥接执行结果文本', async () => {
    const { service, token } = await startService();
    const handler = vi.fn(async () => ({ accepted: true, reply: '34 个测试文件全部通过' }));
    service.onCommand(handler);

    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token, text: '运行测试', clientId: 'mobile-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, reply: '34 个测试文件全部通过' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '运行测试', clientId: 'mobile-1' }),
      expect.any(Function),
    );
  });

  it('validateAndRoute：显式传入 emit 时原样透传给监听器（流式增量通道）', async () => {
    const { service, token } = await startService();
    const emitted: unknown[] = [];
    const handler = vi.fn(async (_command: RemoteCommand, emit: RemoteCommandEmitter) => {
      emit({ type: 'delta', text: '片段' });
      return { accepted: true, reply: '片段' };
    });
    service.onCommand(handler);

    const routed = await service.validateAndRoute(
      { sessionToken: token, text: '任务', clientId: 'mobile-1' },
      (event) => {
        emitted.push(event);
      },
    );
    expect(routed.accepted).toBe(true);
    expect(emitted).toEqual([{ type: 'delta', text: '片段' }]);
  });

  it('POST /command：无监听器接管 → accepted=false 且不泄露令牌', async () => {
    const { service, token } = await startService();
    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token, text: '无人执行的命令', clientId: 'm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accepted: false });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('POST /command：令牌不匹配 → 403（监听器不触发）', async () => {
    const { service } = await startService();
    const handler = vi.fn(async () => ({ accepted: true }));
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

  it('GET /：返回内置手机控制页（严格 CSP，不含令牌）', async () => {
    const { service, token } = await startService();
    const res = await fetch(`${baseUrl(service)}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'sha256-");
    const html = await res.text();
    expect(html).toContain('<textarea id="input"');
    expect(html).not.toContain(token);
  });

  it('POST /command + SSE Accept：按 hello/delta/tool/end 帧序增量回传', async () => {
    const { service, token } = await startService();
    service.onCommand(async (_command, emit) => {
      emit({ type: 'delta', text: '第一段' });
      emit({ type: 'tool', toolName: 'bash' });
      emit({ type: 'delta', text: '第二段' });
      return { accepted: true, reply: '第一段第二段', reason: 'completed' };
    });

    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Accept', 'text/event-stream'],
      ],
      body: JSON.stringify({ sessionToken: token, text: '任务', clientId: 'mobile-1' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = await res.text();
    expect([...stream.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])).toEqual([
      'hello',
      'delta',
      'tool',
      'delta',
      'end',
    ]);
    expect(stream).toContain('data: {"type":"delta","text":"第一段"}');
    expect(stream.slice(stream.indexOf('event: end'))).toContain('"reason":"completed"');
  });

  it('POST /command + SSE Accept：令牌不匹配仍在开启流之前返回 403 JSON', async () => {
    const { service } = await startService();
    const res = await fetch(`${baseUrl(service)}/command`, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Accept', 'text/event-stream'],
      ],
      body: JSON.stringify({ sessionToken: 'wrong', text: 'x', clientId: 'm' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
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

describe('RemoteControlService（绑定范围）', () => {
  /** 绑定回环随机端口的公告接收端（单播注入，跨平台稳定） */
  async function bindReceiver(): Promise<UdpSocket> {
    const receiver = createSocket({ type: 'udp4' });
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.bind(0, '127.0.0.1', () => resolve());
    });
    return receiver;
  }

  /** 等待首个公告包（超时未收到即失败） */
  function firstPacket(receiver: UdpSocket, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${timeoutMs}ms 内未收到发现公告`)),
        timeoutMs,
      );
      receiver.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 断言窗口内静默（无任何公告到达；收到即失败） */
  function expectSilent(receiver: UdpSocket, windowMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        receiver.off('message', onMessage);
        resolve();
      }, windowMs);
      const onMessage = (): void => {
        clearTimeout(timer);
        receiver.off('message', onMessage);
        reject(new Error('仅本机模式不应发出发现公告'));
      };
      receiver.on('message', onMessage);
    });
  }

  it('listen 地址按绑定范围解析：lan→0.0.0.0、loopback→127.0.0.1（OS 回报）', async () => {
    const lan = await startService();
    expect(lan.service.getBindScope()).toBe('lan');
    expect(lan.service.getBindAddress()).toBe('0.0.0.0');

    const loopback = await startService({ bindScope: 'loopback' });
    expect(loopback.service.getBindScope()).toBe('loopback');
    expect(loopback.service.getBindAddress()).toBe('127.0.0.1');
    expect(loopback.service.getBindAddress()).not.toBe('0.0.0.0');
  });

  it('仅本机模式：HTTP 在回环地址可达（/info 仅回环可达，不再暴露给局域网）', async () => {
    const { service } = await startService({ bindScope: 'loopback' });
    const res = await fetch(`http://127.0.0.1:${service.getPort()}/info`);
    expect(res.status).toBe(200);
    expect(service.getBindAddress()).toBe('127.0.0.1');
  });

  it('仅本机模式：不发 UDP 发现公告（不向局域网广播自身存在）', async () => {
    const receiver = await bindReceiver();
    try {
      const discoveryPort = (receiver.address() as { port: number }).port;
      await startService({
        bindScope: 'loopback',
        discoveryPort,
        broadcastAddress: '127.0.0.1',
        broadcastIntervalMs: 30,
      });
      // 窗口 ≥ 10 个广播间隔：若误发公告必然落入窗口
      await expectSilent(receiver, 500);
    } finally {
      receiver.close();
    }
  });

  it('运行中切换 lan→loopback：令牌保留、按新地址重启、公告立即停发', async () => {
    const receiver = await bindReceiver();
    try {
      const discoveryPort = (receiver.address() as { port: number }).port;
      const { service, token } = await startService({
        discoveryPort,
        broadcastAddress: '127.0.0.1',
        broadcastIntervalMs: 30,
      });
      await firstPacket(receiver, 3000); // lan 模式确认公告在发

      await service.setBindScope('loopback');
      expect(service.isRunning()).toBe(true);
      expect(service.getSessionToken()).toBe(token); // 配对话轮保留，无需重新配对
      expect(service.getBindScope()).toBe('loopback');
      expect(service.getBindAddress()).toBe('127.0.0.1');
      // 间隔 30ms，静默 300ms ≈ 10 个间隔：公告确已停发
      await expectSilent(receiver, 300);
    } finally {
      receiver.close();
    }
  });

  it('运行中切换 loopback→lan：按 0.0.0.0 重启且公告恢复', async () => {
    const receiver = await bindReceiver();
    try {
      const discoveryPort = (receiver.address() as { port: number }).port;
      const { service } = await startService({
        bindScope: 'loopback',
        discoveryPort,
        broadcastAddress: '127.0.0.1',
        broadcastIntervalMs: 30,
      });

      await service.setBindScope('lan');
      expect(service.isRunning()).toBe(true);
      expect(service.getBindScope()).toBe('lan');
      expect(service.getBindAddress()).toBe('0.0.0.0');
      await firstPacket(receiver, 3000); // 公告恢复
    } finally {
      receiver.close();
    }
  });

  it('未运行时切换：仅记录范围，下次 start 按新范围监听', async () => {
    const service = new RemoteControlService({ bindScope: 'lan' });
    activeServices.push(service);

    await service.setBindScope('loopback');
    expect(service.isRunning()).toBe(false);
    expect(service.getBindScope()).toBe('loopback');

    await service.start();
    expect(service.getBindAddress()).toBe('127.0.0.1');
  });

  it('同值切换：幂等 no-op，不重启监听', async () => {
    const { service, token } = await startService();
    const port = service.getPort();
    await service.setBindScope('lan');
    expect(service.isRunning()).toBe(true);
    expect(service.getSessionToken()).toBe(token);
    expect(service.getPort()).toBe(port); // 未重启（随机端口重启必然换端口）
  });
});
