import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';
import { sendWeixinText, WEIXIN_DEFAULT_BASE_URL, WeixinStreamReceiver } from './weixin-stream';

export class WeixinAdapter implements IChannelAdapter {
  readonly kind = 'wechat';
  readonly displayName = '微信';
  readonly implemented = true;
  readonly configHint = 'iLink 机器人 token';

  private readonly sendTextFn: typeof sendWeixinText;
  private readonly receiverCtor: typeof WeixinStreamReceiver;

  constructor(
    options: {
      sendText?: typeof sendWeixinText;
      Receiver?: typeof WeixinStreamReceiver;
    } = {},
  ) {
    this.sendTextFn = options.sendText ?? sendWeixinText;
    this.receiverCtor = options.Receiver ?? WeixinStreamReceiver;
  }

  isConnected = false;
  private token: string | null = null;
  private receiver: WeixinStreamReceiver | null = null;

  async connect(token: string | undefined): Promise<void> {
    if (token === undefined || token.trim().length === 0) {
      throw new Error('微信：缺少 iLink token');
    }
    this.token = token.trim();

    const receiver = new this.receiverCtor({ token: this.token });
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

  async disconnect(): Promise<void> {
    this.receiver?.close();
    this.receiver = null;
    this.isConnected = false;
  }

  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    if (this.token === null) {
      throw new Error('微信：渠道未连接');
    }
    const contextToken = this.receiver?.getContextToken(target.chatId);
    await this.sendTextFn({
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
      token: this.token,
      toUserId: target.chatId,
      text,
      contextToken,
    });
  }

  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  private readonly messageHandlers = new Set<(message: ChannelIncomingMessage) => void>();
}
