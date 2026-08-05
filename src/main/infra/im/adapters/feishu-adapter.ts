// src/main/infra/im/adapters/feishu-adapter.ts
// 飞书渠道：webhook 发送（markdown）+ 长连接接收（官方 SDK WSClient）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式，二选一）：
// 1. 仅发送：webhook 完整 URL（https://open.feishu.cn/open-apis/bot/v2/hook/xxx）
// 2. 发送+接收：appId:appSecret:webhookUrl（长连接接收应用机器人消息）
// 接收说明：长连接需要自建应用（非自定义机器人）；入站为应用机器人接收的群聊/单聊文本。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';
import { FeishuStreamReceiver } from './feishu-stream';
import { WebhookChannelAdapter } from './webhook-channel';

/** Stream 配置分隔符（appId:appSecret:webhookUrl） */
const STREAM_SEPARATOR = ':';

/** 飞书文本内容上限（官方限制 30KB，保守截断） */
const FEISHU_MAX_CONTENT = 8000;

/**
 * 飞书渠道适配器（webhook 发送 + 可选长连接接收）
 */
export class FeishuAdapter extends WebhookChannelAdapter {
  readonly kind = 'feishu';
  readonly displayName = '飞书';
  readonly implemented = true;

  private streamReceiver: FeishuStreamReceiver | null = null;
  private streamHandler: ((message: ChannelIncomingMessage) => void) | null = null;

  /** 覆写：token 解析支持 Stream 三元组 */
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
        // 严格判定：appId 为纯字母数字（飞书 appId 形状），webhookUrl 为 http(s) 地址
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

  /** 覆写：connect 后启动长连接接收（若配置） */
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

  /** 覆写：订阅入站（长连接接收转发） */
  override onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.streamHandler = handler;
    return () => {
      this.streamHandler = null;
    };
  }

  /** 覆写：断开时关闭长连接 */
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
