import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';
import { FeishuStreamReceiver } from './feishu-stream';
import { WebhookChannelAdapter } from './webhook-channel';

const STREAM_SEPARATOR = ':';

const FEISHU_MAX_CONTENT = 8000;

export class FeishuAdapter extends WebhookChannelAdapter {
  readonly kind = 'feishu';
  readonly displayName = '飞书';
  readonly implemented = true;
  override readonly configHint: string = 'webhook URL 或 appId:appSecret:webhookUrl（发送+接收）';

  private streamReceiver: FeishuStreamReceiver | null = null;
  private streamHandler: ((message: ChannelIncomingMessage) => void) | null = null;

  protected override parseToken(token: string): string {
    if (token.includes(STREAM_SEPARATOR)) {
      const parts = token.split(STREAM_SEPARATOR);
      const appId = parts[0];
      const appSecret = parts[1];
      const webhookUrl = parts[2];
      if (
        parts.length === 3 &&
        appId !== undefined &&
        appSecret !== undefined &&
        webhookUrl !== undefined &&
        appId.length > 0 &&
        appSecret.length > 0 &&
        webhookUrl.length > 0 &&
        /^[a-zA-Z0-9]+$/.test(appId) &&
        (webhookUrl.startsWith('http://') || webhookUrl.startsWith('https://'))
      ) {
        this.streamReceiver = new FeishuStreamReceiver({
          appId,
          appSecret,
        });
        this.streamReceiver.onMessage((message) => {
          this.streamHandler?.(message);
        });
        logger.info({ kind: this.kind }, '飞书长连接接收已配置');
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
        logger.error({ error: err }, '飞书长连接接收启动失败');
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
      msg_type: 'markdown',
      content: {
        text: text.length > FEISHU_MAX_CONTENT ? `${text.slice(0, FEISHU_MAX_CONTENT)}…` : text,
      },
    };
  }
}
