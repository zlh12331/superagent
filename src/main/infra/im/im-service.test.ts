// src/main/infra/im/im-service.test.ts
// IM 聚合服务单测：start/stop/list/send/restore/消息分发（fake 适配器注入）

import type { ChannelKind, IChannelInfo } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from './channel/types';
import { ImService } from './im-service';

// keychain 外壳（safeStorage 为 Electron 原生模块，规范允许 vi.mock 外壳）
vi.mock('../storage/keychain', () => ({
  getSecret: vi.fn(async () => null),
  setSecret: vi.fn(async () => {}),
}));

import { getSecret } from '../storage/keychain';

/** fake 渠道适配器（手写最小实现，无 mock 框架） */
class FakeAdapter implements IChannelAdapter {
  readonly kind: ChannelKind;
  readonly displayName: string;
  readonly implemented: boolean;
  readonly configHint: string;
  isConnected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  sent: Array<{ target: ChannelTarget; text: string }> = [];
  private handlers = new Set<(message: ChannelIncomingMessage) => void>();

  constructor(kind: ChannelKind, implemented = true) {
    this.kind = kind;
    this.displayName = `渠道-${kind}`;
    this.implemented = implemented;
    this.configHint = implemented ? '测试配置' : '待接入';
  }

  async connect(): Promise<void> {
    // 未实现渠道（implemented=false）：抛 NOT_IMPLEMENTED（对齐 IChannelAdapter 契约）
    if (!this.implemented) {
      throw new Error('IM_CHANNEL_NOT_IMPLEMENTED');
    }
    this.connectCalls += 1;
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }

  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    this.sent.push({ target, text });
  }

  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 测试辅助：模拟入站消息 */
  emit(message: ChannelIncomingMessage): void {
    for (const handler of this.handlers) {
      handler(message);
    }
  }
}

/** 构造测试服务（fake 适配器注入） */
function createService(): { service: ImService; adapters: FakeAdapter[] } {
  const telegram = new FakeAdapter('telegram');
  const skeleton = new FakeAdapter('wechat', false);
  const service = new ImService([telegram, skeleton]);
  return { service, adapters: [telegram, skeleton] };
}

describe('ImService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start：连接渠道并记录运行状态（token 入 keychain）', async () => {
    const { service, adapters } = createService();
    await service.start('telegram', 'tok-1');
    expect(adapters[0]?.isConnected).toBe(true);
    expect(adapters[0]?.connectCalls).toBe(1);
    const channels = await service.list();
    expect(channels.find((c) => c.kind === 'telegram')?.running).toBe(true);
  });

  it('start：骨架渠道抛 NOT_IMPLEMENTED', async () => {
    const { service } = createService();
    await expect(service.start('wechat', 'x')).rejects.toThrow();
  });

  it('start：无 token 时从 keychain 读取', async () => {
    const { service, adapters } = createService();
    vi.mocked(getSecret).mockResolvedValueOnce('stored-token');
    await service.start('telegram');
    expect(adapters[0]?.isConnected).toBe(true);
    expect(getSecret).toHaveBeenCalledWith('im:telegram');
  });

  it('stop：断开并清除运行状态（幂等）', async () => {
    const { service, adapters } = createService();
    await service.start('telegram', 't');
    await service.stop('telegram');
    expect(adapters[0]?.isConnected).toBe(false);
    await service.stop('telegram'); // 幂等
    const channels = await service.list();
    expect(channels.find((c) => c.kind === 'telegram')?.running).toBe(false);
  });

  it('list：渠道状态（implemented/configured/running）', async () => {
    const { service } = createService();
    const channels: IChannelInfo[] = await service.list();
    expect(channels).toHaveLength(2);
    const telegram = channels.find((c) => c.kind === 'telegram');
    expect(telegram?.implemented).toBe(true);
    expect(telegram?.configured).toBe(false);
    expect(telegram?.description).toBe('测试配置');
  });

  it('send：回发消息（渠道已连接）', async () => {
    const { service, adapters } = createService();
    await service.start('telegram', 't');
    await service.send('telegram', 'chat-1', '回复');
    expect(adapters[0]?.sent).toHaveLength(1);
    expect(adapters[0]?.sent[0]?.text).toBe('回复');
  });

  it('send：渠道未连接不抛（降级日志）', async () => {
    const { service } = createService();
    await expect(service.send('telegram', 'chat-1', 'x')).resolves.toBeUndefined();
  });

  it('onMessage：渠道消息分发到监听器（unsubscribe 生效）', async () => {
    const { service, adapters } = createService();
    const received: ChannelIncomingMessage[] = [];
    const unsubscribe = service.onMessage((message) => {
      received.push(message);
    });
    const msg: ChannelIncomingMessage = {
      channel: 'telegram',
      chatId: 'chat-1',
      senderId: 'user-1',
      text: '你好',
      messageId: 'm1',
      timestamp: Date.now(),
    };
    adapters[0]?.emit(msg);
    expect(received).toHaveLength(1);
    unsubscribe();
    adapters[0]?.emit(msg);
    expect(received).toHaveLength(1); // 取消后不再收到
  });

  it('restore：仅恢复已配置且已实现的渠道', async () => {
    const { service, adapters } = createService();
    vi.mocked(getSecret).mockImplementation(async (key: string) =>
      key === 'im:telegram' ? 'stored' : null,
    );
    await service.restore();
    expect(adapters[0]?.isConnected).toBe(true); // telegram 已配置 → 恢复
    expect(adapters[1]?.isConnected).toBe(false); // 骨架未实现 → 不恢复
  });

  it('stopAll：全部渠道断开', async () => {
    const { service, adapters } = createService();
    await service.start('telegram', 't');
    await service.stopAll();
    expect(adapters[0]?.isConnected).toBe(false);
  });
});
