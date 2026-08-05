// src/main/infra/im/adapters/wecom-adapter.ts
// 企业微信渠道：webhook 发送（markdown）+ 长连接接收（官方 aibot SDK）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式，二选一）：
// 1. 仅发送：webhook 完整 URL（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx）
// 2. 发送+接收：botId:secret:webhookUrl（智能机器人长连接接收）
// 接收说明：长连接需要企业微信智能机器人（botId/secret 在后台获取）；入站为机器人会话消息。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';
import { WebhookChannelAdapter } from './webhook-channel';
import { WecomStreamReceiver } from './wecom-stream';

/** Stream 配置分隔符（botId:secret:webhookUrl） */
const STREAM_SEPARATOR = ':';

/** 企业微信 markdown 内容上限（官方限制 4096 字节） */
const WECOM_MAX_CONTENT = 4000;

/**
 * 企业微信渠道适配器（webhook 发送 + 可选长连接接收）
 */
export class WecomAdapter extends WebhookChannelAdapter {
  readonly kind = 'wecom';
  readonly displayName = '企业微信';
  readonly implemented = true;

  private streamReceiver: WecomStreamReceiver | null = null;
  private streamHandler: ((message: ChannelIncomingMessage) => void) | null = null;

  /** 覆写：token 解析支持 Stream 三元组 */
  protected override parseToken(token: string): string {
    if (token.includes(STREAM_SEPARATOR)) {
      const parts = token.split(STREAM_SEPARATOR);
      const botId = parts[0];
      const secret = parts[1];
      const webhookUrl = parts[2];
      if (
        parts.length === 3 &&
        botId !== undefined &&
        secret !== undefined &&
        webhookUrl !== undefined &&
        botId.length > 0 &&
        secret.length > 0 &&
        webhookUrl.length > 0 &&
        // 严格判定：botId 为纯字母数字（企业微信 botId 形状），webhookUrl 为 http(s) 地址
        /^[a-zA-Z0-9]+$/.test(botId) &&
        (webhookUrl.startsWith('http://') || webhookUrl.startsWith('https://'))
      ) {
        this.streamReceiver = new WecomStreamReceiver({
          botId,
          secret,
        });
        this.streamReceiver.onMessage((message) => {
          this.streamHandler?.(message);
        });
        logger.info({ kind: this.kind }, '企业微信长连接接收已配置');
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
        logger.error({ error: err }, '企业微信长连接接收启动失败');
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
      msgtype: 'markdown',
      markdown: {
        content: text.length > WECOM_MAX_CONTENT ? `${text.slice(0, WECOM_MAX_CONTENT)}…` : text,
      },
    };
  }
}
