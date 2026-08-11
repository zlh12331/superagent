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
  readonly configHint = 'appId:appSecret（官方机器人凭证）';

  /**
   * 外部依赖注入点（测试传 fake，生产默认实现）：
   * - fetchTokenFn：access_token 获取（网络）
   * - Receiver：Gateway 长连接接收器（WS）
   * - fetchFn：发送消息 HTTP（网络）
   */
  private readonly fetchTokenFn: typeof fetchQqAccessToken;
  private readonly receiverCtor: typeof QqStreamReceiver;
  private readonly fetchFn: typeof fetch;

  constructor(
    options: {
      fetchToken?: typeof fetchQqAccessToken;
      Receiver?: typeof QqStreamReceiver;
      fetchFn?: typeof fetch;
    } = {},
  ) {
    this.fetchTokenFn = options.fetchToken ?? fetchQqAccessToken;
    this.receiverCtor = options.Receiver ?? QqStreamReceiver;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  isConnected = false;
  private appIdValue: string | null = null;
  private appSecretValue: string | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
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
    this.appIdValue = appId;
    this.appSecretValue = appSecret;
    await this.refreshAccessToken(appId, appSecret);

    // 启动长连接接收
    const receiver = new this.receiverCtor({ appId, appSecret });
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
    const chatType = this.chatTypeMap.get(target.chatId) ?? 'user';
    const endpoint =
      chatType === 'group'
        ? `${API_HOST}/v2/groups/${target.chatId}/messages`
        : `${API_HOST}/v2/users/${target.chatId}/messages`;
    // access_token 过期前刷新（官方：7200s 生命周期，需自行刷新）
    if (this.appIdValue !== null && this.appSecretValue !== null && this.isTokenExpiring()) {
      await this.refreshAccessToken(this.appIdValue, this.appSecretValue);
    }
    if (this.accessToken === null) {
      throw new AppError(ErrorCode.IM_CHANNEL_NOT_CONFIGURED, 'QQ：渠道未连接');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), SEND_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify({ content: text, msg_type: 0 }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as {
        err_code?: number;
        message?: string;
      } | null;
      // 官方：依据 err_code 判断失败（message 可能调整）
      if (!response.ok || (body?.err_code !== undefined && body.err_code !== 0)) {
        throw new Error(
          body?.err_code !== undefined
            ? `QQ 发送失败（err_code ${body.err_code}）：${body.message ?? '未知'}`
            : `HTTP ${response.status} ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 是否接近过期（剩余 <60s 视为过期窗口；官方：过期前 60s 内获取新 token） */
  private isTokenExpiring(): boolean {
    return Date.now() >= this.accessTokenExpiresAt - 60_000;
  }

  /** 获取/刷新 access_token（记录过期时间） */
  private async refreshAccessToken(appId: string, appSecret: string): Promise<void> {
    const { accessToken, expiresIn } = await this.fetchTokenFn(appId, appSecret);
    this.accessToken = accessToken;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
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
