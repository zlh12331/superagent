import type { ChannelKind, IChannelInfo } from '@code-agent/shared/main';
import { INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import { broadcastInvalidation } from '../invalidation/invalidation';
import { getSecret, setSecret } from '../storage/keychain';
import { createAllAdapters } from './adapters';
import type { ChannelIncomingMessage, IChannelAdapter } from './channel/types';

export function channelKeychainKey(kind: ChannelKind): string {
  return `im:${kind}`;
}

export class ImService {
  private readonly adapters: IChannelAdapter[];
  private readonly messageListeners = new Set<(message: ChannelIncomingMessage) => void>();
  private readonly started = new Set<ChannelKind>();

  constructor(adapters?: readonly IChannelAdapter[]) {
    this.adapters = adapters !== undefined ? [...adapters] : createAllAdapters();
  }

  async start(kind: ChannelKind, token?: string): Promise<void> {
    const adapter = this.getAdapter(kind);
    if (token !== undefined && token.length > 0) {
      await setSecret(channelKeychainKey(kind), token);
    }
    const stored =
      token !== undefined && token.length > 0 ? token : await getSecret(channelKeychainKey(kind));
    await adapter.connect(stored ?? undefined);
    if (adapter.isConnected) {
      const wasRunning = this.started.has(kind);
      this.started.add(kind);
      logger.info({ kind }, 'IM 渠道已启动');
      if (!wasRunning) {
        broadcastInvalidation([INVALIDATION_DOMAINS.im]);
      }
    }
  }

  async stop(kind: ChannelKind): Promise<void> {
    const adapter = this.getAdapter(kind);
    await adapter.disconnect();
    const wasRunning = this.started.delete(kind);
    logger.info({ kind }, 'IM 渠道已停止');
    if (wasRunning) {
      broadcastInvalidation([INVALIDATION_DOMAINS.im]);
    }
  }

  async list(): Promise<IChannelInfo[]> {
    return Promise.all(
      this.adapters.map(async (adapter) => ({
        kind: adapter.kind,
        displayName: adapter.displayName,
        description: adapterDescription(adapter),
        implemented: adapter.implemented,
        configured: (await getSecret(channelKeychainKey(adapter.kind))) !== null,
        running: this.started.has(adapter.kind),
      })),
    );
  }

  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.messageListeners.add(handler);
    const unsubscribes = this.adapters.map((adapter) =>
      adapter.onMessage((message) => {
        for (const listener of this.messageListeners) {
          try {
            listener(message);
          } catch (err: unknown) {
            logger.error({ error: err, channel: message.channel }, 'IM 消息监听器异常');
          }
        }
      }),
    );
    return () => {
      this.messageListeners.delete(handler);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  async send(kind: ChannelKind, chatId: string, text: string): Promise<void> {
    const adapter = this.getAdapter(kind);
    if (!adapter.isConnected) {
      logger.warn({ kind, chatId }, '渠道未连接，回发失败');
      return;
    }
    try {
      await adapter.sendMessage({ chatId }, text);
    } catch (err: unknown) {
      logger.error({ kind, chatId, error: err }, '渠道回发失败');
    }
  }

  async restore(): Promise<void> {
    const channels = await this.list();
    for (const channel of channels) {
      if (!channel.configured || !channel.implemented) {
        continue;
      }
      try {
        await this.start(channel.kind);
      } catch (err: unknown) {
        logger.warn({ kind: channel.kind, error: err }, 'IM 渠道启动恢复失败');
      }
    }
  }

  async stopAll(): Promise<void> {
    const hadRunning = this.started.size > 0;
    await Promise.allSettled(this.adapters.map((adapter) => adapter.disconnect()));
    this.started.clear();
    if (hadRunning) {
      broadcastInvalidation([INVALIDATION_DOMAINS.im]);
    }
  }

  private getAdapter(kind: ChannelKind): IChannelAdapter {
    const adapter = this.adapters.find((a) => a.kind === kind);
    if (adapter === undefined) {
      throw new Error(`未知 IM 渠道: ${kind}`);
    }
    return adapter;
  }
}

function adapterDescription(adapter: IChannelAdapter): string {
  if (!adapter.implemented) {
    return `待接入：${adapter.configHint}`;
  }
  return adapter.configHint;
}
