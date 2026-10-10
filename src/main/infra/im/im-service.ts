import type { ChannelKind, IChannelInfo } from '@code-agent/shared/main';
import { INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import { broadcastInvalidation } from '../invalidation/invalidation';
import { getSecret, setSecret } from '../storage/keychain';
import { createAllAdapters } from './adapters';
import type { ChannelIncomingMessage, IChannelAdapter } from './channel/types';

/** keychain key 约定：im:${kind}（渠道 token 不落库） */
export function channelKeychainKey(kind: ChannelKind): string {
  return `im:${kind}`;
}

/**
 * IM 渠道服务（模块单例，与 ServiceContainer 生命周期一致）
 */
export class ImService {
  private readonly adapters: IChannelAdapter[];
  /** 渠道消息监听器（桥接层挂载点） */
  private readonly messageListeners = new Set<(message: ChannelIncomingMessage) => void>();
  /** 已启动渠道集合 */
  private readonly started = new Set<ChannelKind>();

  /**
   * 构造注入（测试可控；缺省 createAllAdapters 全部渠道）
   */
  constructor(adapters?: readonly IChannelAdapter[]) {
    this.adapters = adapters !== undefined ? [...adapters] : createAllAdapters();
  }

  /**
   * 启动渠道（token 优先取入参；否则读 keychain；骨架渠道抛 NOT_IMPLEMENTED）
   */
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

  /**
   * 停止渠道（幂等）
   */
  async stop(kind: ChannelKind): Promise<void> {
    const adapter = this.getAdapter(kind);
    await adapter.disconnect();
    const wasRunning = this.started.delete(kind);
    logger.info({ kind }, 'IM 渠道已停止');
    if (wasRunning) {
      broadcastInvalidation([INVALIDATION_DOMAINS.im]);
    }
  }

  /**
   * 渠道状态列表（设置页展示）
   */
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

  /**
   * 订阅入站消息（桥接层接入点；返回取消订阅）
   */
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

  /**
   * 回发消息到指定渠道（桥接层调用；失败记录日志不抛）
   */
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

  /**
   * 应用启动时恢复：已配置渠道自动连接（ServiceContainer init 调用）
   */
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

  /**
   * 全部渠道停止（应用退出）
   */
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

/** 渠道描述（各适配器自带配置说明 configHint；骨架渠道显示待接入原因） */
function adapterDescription(adapter: IChannelAdapter): string {
  if (!adapter.implemented) {
    return `待接入：${adapter.configHint}`;
  }
  return adapter.configHint;
}
