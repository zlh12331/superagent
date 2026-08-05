// src/main/infra/im/adapters/qq-adapter.ts
// QQ 渠道适配器：官方 API 发送 + Gateway 长连接接收
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式）：appId:appSecret（QQ 开放平台应用凭证）
// 发送：官方 API（群聊 /v2/groups/{openid}/messages；单聊 /v2/users/{openid}/messages）
//       —— chatId 即 openid（入站事件学习 openid 类型，回发自动路由）
// 接收：Gateway WS 长连接（GROUP_AT_MESSAGE / C2C_MESSAGE）
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';
import { fetchQqAccessToken, QqStreamReceiver } from './qq-stream';

/** API 基地址（沙箱可注入） */
const API_HOST = 'https://api.sgroup.qq.com';
/** 发送超时 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * QQ 渠道适配器（官方 API 发送 + Gateway 长连接接收）
 */
export class QqAdapter implements IChannelAdapter {
  readonly kind = 'qq';
  readonly displayName = 'QQ';
  readonly implemented = true;

  isConnected = false;
  private accessToken: string | null = null;
  /** openid → 会话类型（入站事件学习：群/单聊路由） */
  private readonly chatTypeMap = new Map<string, 'group' | 'user'>();
  private receiver: QqStreamReceiver | null = null;

  /**
   * 连接（token 格式 appId:appSecret）
   */
  async connect(token: string | undefined): Promise<void> {
    if (token === undefined || token.length === 0) {
      throw new AppError(ErrorCode.IM_CHANNEL_INVALID_TOKEN, 'QQ：缺少 appId:appSecret');
    }
    const parts = token.split(':');
    const appId = parts[0];
    const appSecret = parts[1];
    if (
      parts.length !== 2 ||
      appId === undefined ||
      appSecret === undefined ||
      appId.length === 0 ||
      appSecret.length === 0
    ) {
      throw new AppError(ErrorCode.IM_CHANNEL_INVALID_TOKEN, 'QQ：无效的 appId:appSecret');
    }
    const { accessToken } = await fetchQqAccessToken(appId, appSecret);
    this.accessToken = accessToken;

    // 启动长连接接收
    const receiver = new QqStreamReceiver({ appId, appSecret });
    receiver.onMessage((message) => {
      // 学习 openid 类型（群/单聊路由）
      if (message.channelType !== undefined) {
        this.chatTypeMap.set(message.chatId, message.channelType);
      }
      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (err: unknown) {
          logger.error({ error: err }, 'QQ 消息监听器异常');
        }
      }
    });
    await receiver.open();
    this.receiver = receiver;
    this.isConnected = true;
    logger.info({ kind: this.kind }, 'QQ 渠道已连接');
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    this.receiver?.close();
    this.receiver = null;
    this.isConnected = false;
  }

  /**
   * 回发消息（chatId 即 openid；群/单聊按入站学习路由）
   */
  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    if (this.accessToken === null) {
      throw new AppError(ErrorCode.IM_CHANNEL_NOT_CONFIGURED, 'QQ：渠道未连接');
    }
    const chatType = this.chatTypeMap.get(target.chatId) ?? 'user';
    const endpoint =
      chatType === 'group'
        ? `${API_HOST}/v2/groups/${target.chatId}/messages`
        : `${API_HOST}/v2/users/${target.chatId}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify({ content: text, msg_type: 0 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 订阅入站消息（多订阅者：与 im-service 兼容） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  private readonly messageHandlers = new Set<(message: ChannelIncomingMessage) => void>();
}
