import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';
import { DingTalkStreamReceiver, parseDingTalkEvent } from './dingtalk-stream';
import { dingtalkSign, WebhookChannelAdapter } from './webhook-channel';

const STREAM_SEPARATOR = ':';

export class DingTalkAdapter extends WebhookChannelAdapter {
  readonly kind = 'dingtalk';
  readonly displayName = '钉钉';
  readonly implemented = true;
  override readonly configHint: string = 'webhook URL 或 appKey:appSecret:webhookUrl（发送+接收）';

  private streamReceiver: DingTalkStreamReceiver | null = null;
  private streamHandler: ((message: ChannelIncomingMessage) => void) | null = null;

  protected override parseToken(token: string): string {
    if (token.includes(STREAM_SEPARATOR)) {
      const parts = token.split(STREAM_SEPARATOR);
      const appKey = parts[0];
      const appSecret = parts[1];
      const webhookUrl = parts[2];
      if (
        parts.length === 3 &&
        appKey !== undefined &&
        appSecret !== undefined &&
        webhookUrl !== undefined &&
        appKey.length > 0 &&
        appSecret.length > 0 &&
        webhookUrl.length > 0 &&
        /^[a-zA-Z0-9]+$/.test(appKey) &&
        (webhookUrl.startsWith('http://') || webhookUrl.startsWith('https://'))
      ) {
        this.streamReceiver = new DingTalkStreamReceiver({
          appKey,
          appSecret,
        });
        this.streamReceiver.onMessage((message) => {
          this.streamHandler?.(message);
        });
        logger.info({ kind: this.kind }, '钉钉 Stream 接收已配置');
        return webhookUrl;
      }
    }
    return token;
  }

  protected override async afterConnect(): Promise<void> {
    if (this.streamReceiver !== null) {
      try {
        await this.streamReceiver.open();
      } catch (err: unknown) {
        logger.error({ error: err }, '钉钉 Stream 接收启动失败');
        throw err;
      }
    }
  }

  override onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.streamHandler = handler;
    return () => {
      this.streamHandler = null;
    };
  }

  protected override async afterDisconnect(): Promise<void> {
    this.streamReceiver?.close();
  }

  protected buildPayload(text: string): unknown {
    return {
      msgtype: 'markdown',
      markdown: {
        title: 'Code Agent 消息',
        text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      },
    };
  }

  protected override async decorateUrl(url: string): Promise<string> {
    const secret = this.getSecret();
    if (secret === null) {
      return url;
    }
    const timestamp = Date.now();
    const sign = await dingtalkSign(secret, timestamp);
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  static parseEvent = parseDingTalkEvent;
}
