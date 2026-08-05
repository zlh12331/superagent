// src/main/infra/im/adapters/weixin-adapter.ts
// 微信渠道适配器：iLink 智能机器人（长轮询接收 + 消息发送）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式）：iLink 机器人 token（ilinkai.weixin.qq.com 网关）
// 接收：getupdates 长轮询（游标续传；本地可行——无需公网回调）
// 发送：sendmsg（context_token 从入站消息学习，回发自动携带）
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';
import { sendWeixinText, WEIXIN_DEFAULT_BASE_URL, WeixinStreamReceiver } from './weixin-stream';

/**
 * 微信渠道适配器（iLink 轮询接收 + 消息发送）
 */
export class WeixinAdapter implements IChannelAdapter {
  readonly kind = 'wechat';
  readonly displayName = '微信';
  readonly implemented = true;
  readonly configHint = 'iLink 机器人 token';

  isConnected = false;
  private token: string | null = null;
  /** from_user_id → context_token（回发携带） */
  private receiver: WeixinStreamReceiver | null = null;

  /**
   * 连接（token 为 iLink 机器人 token）
   */
  async connect(token: string | undefined): Promise<void> {
    if (token === undefined || token.trim().length === 0) {
      throw new Error('微信：缺少 iLink token');
    }
    this.token = token.trim();

    const receiver = new WeixinStreamReceiver({ token: this.token });
    receiver.onMessage((message) => {
      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (err: unknown) {
          logger.error({ error: err }, '微信消息监听器异常');
        }
      }
    });
    receiver.open();
    this.receiver = receiver;
    this.isConnected = true;
    logger.info({ kind: this.kind }, '微信渠道已连接（iLink 轮询）');
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    this.receiver?.close();
    this.receiver = null;
    this.isConnected = false;
  }

  /**
   * 回发消息（chatId 即 from_user_id；携带 context_token）
   */
  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    if (this.token === null) {
      throw new Error('微信：渠道未连接');
    }
    const contextToken = this.receiver?.getContextToken(target.chatId);
    await sendWeixinText(WEIXIN_DEFAULT_BASE_URL, this.token, target.chatId, text, contextToken);
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
