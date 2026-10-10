import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelKind, IChannelInfo } from '@code-agent/shared/main';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelIncomingMessage,
  ChannelTarget,
  IChannelAdapter,
} from '../infra/im/channel/types';
import { ImService } from '../infra/im/im-service';
import { createImHandlers } from './im.handler';

const TEMP_DIR = mkdtempSync(join(tmpdir(), 'im-handler-test-'));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, '')),
  },
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? TEMP_DIR : `/tmp/${name}`)),
    isPackaged: false,
  },
}));

class FakeAdapter implements IChannelAdapter {
  readonly kind: ChannelKind;
  readonly displayName: string;
  readonly implemented: boolean;
  readonly configHint: string;
  isConnected = false;

  constructor(kind: ChannelKind, implemented = true) {
    this.kind = kind;
    this.displayName = `渠道-${kind}`;
    this.implemented = implemented;
    this.configHint = '测试配置';
  }

  async connect(): Promise<void> {
    if (!this.implemented) {
      throw new Error('IM_CHANNEL_NOT_IMPLEMENTED');
    }
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async sendMessage(_target: ChannelTarget, _text: string): Promise<void> {}

  onMessage(_handler: (message: ChannelIncomingMessage) => void): () => void {
    return () => {};
  }
}

function createHandlers(): ReturnType<typeof createImHandlers> {
  const service = new ImService([new FakeAdapter('telegram'), new FakeAdapter('wechat', false)]);
  return createImHandlers({ imService: service });
}

describe('im.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {});

  afterAll(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('list：返回渠道状态列表', async () => {
    const handlers = createHandlers();
    const result = await handlers.list(undefined, {} as never);
    expect(result.channels).toHaveLength(2);
    const channels: readonly IChannelInfo[] = result.channels;
    const telegram = channels.find((c) => c.kind === 'telegram');
    expect(telegram?.implemented).toBe(true);
    expect(telegram?.running).toBe(false);
    const skeleton = channels.find((c) => c.kind === 'wechat');
    expect(skeleton?.implemented).toBe(false);
  });

  it('start：启动渠道（token 传入）', async () => {
    const handlers = createHandlers();
    const result = await handlers.start({ kind: 'telegram', token: 'tok-1' }, {} as never);
    expect(result).toEqual({ ok: true });
    const channels = (await handlers.list(undefined, {} as never)).channels;
    expect(channels.find((c) => c.kind === 'telegram')?.running).toBe(true);
  });

  it('start：无 token 启动（读 keychain——未配置时抛错）', async () => {
    const handlers = createHandlers();
    await expect(handlers.start({ kind: 'wechat', token: undefined }, {} as never)).rejects.toThrow(
      'NOT_IMPLEMENTED',
    );
  });

  it('stop：停止渠道（幂等）', async () => {
    const handlers = createHandlers();
    await handlers.start({ kind: 'telegram', token: 't' }, {} as never);
    const stopped = await handlers.stop({ kind: 'telegram' }, {} as never);
    expect(stopped).toEqual({ ok: true });
    await handlers.stop({ kind: 'telegram' }, {} as never);
    const channels = (await handlers.list(undefined, {} as never)).channels;
    expect(channels.find((c) => c.kind === 'telegram')?.running).toBe(false);
  });
});
