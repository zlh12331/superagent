// src/main/infra/im/im-service.ts
// IM 渠道聚合服务：配置 / 生命周期 / 消息桥接挂载点
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渠道注册表管理（createAllAdapters 统一实例化）
// - 启动/停止（keychain 读 token → adapter.connect；失败分类）
// - 入站消息统一入口（消息 → agent 的桥接挂载点）
// - 渠道状态查询（设置页列表）
//
// 设计：
// - 敏感配置（token）存 keychain（key = `im:${kind}`），不落库
// - 桥接层（消息 → agent 回合）依赖"无 webContents 的 agent 执行"：
//   AgentCore 抽取（agent-service 组装逻辑独立化）后在此接入，
//   当前阶段入站消息仅记录日志 + 透传状态事件（桥接挂载点就绪）
// - 启动时自动恢复：已配置渠道自动 connect（应用启动时调用 restore()）
// ──────────────────────────────────────────────────────────────

import type { ChannelKind, IChannelInfo } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
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
  private readonly adapters: IChannelAdapter[] = createAllAdapters();
  /** 渠道消息监听器（桥接层挂载点） */
  private readonly messageListeners = new Set<(message: ChannelIncomingMessage) => void>();
  /** 已启动渠道集合 */
  private readonly started = new Set<ChannelKind>();

  /**
   * 启动渠道（token 优先取入参；否则读 keychain；骨架渠道抛 NOT_IMPLEMENTED）
   */
  async start(kind: ChannelKind, token?: string): Promise<void> {
    const adapter = this.getAdapter(kind);
    // 首次启动提供的 token 存入 keychain（后续启动免填）
    if (token !== undefined && token.length > 0) {
      await setSecret(channelKeychainKey(kind), token);
    }
    const stored =
      token !== undefined && token.length > 0 ? token : await getSecret(channelKeychainKey(kind));
    await adapter.connect(stored ?? undefined);
    if (adapter.isConnected) {
      this.started.add(kind);
      logger.info({ kind }, 'IM 渠道已启动');
    }
  }

  /**
   * 停止渠道（幂等）
   */
  async stop(kind: ChannelKind): Promise<void> {
    const adapter = this.getAdapter(kind);
    await adapter.disconnect();
    this.started.delete(kind);
    logger.info({ kind }, 'IM 渠道已停止');
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
    // 渠道层消息 → 统一入口（去重由渠道层负责）
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
    await Promise.allSettled(this.adapters.map((adapter) => adapter.disconnect()));
    this.started.clear();
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
