// src/main/infra/im/adapters/dingtalk-adapter.ts
// 钉钉渠道：webhook 发送（markdown；可选加签）+ Stream 模式接收（企业应用长连接）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式，三选一）：
// 1. 仅发送：webhook 完整 URL（https://oapi.dingtalk.com/robot/send?access_token=xxx）
// 2. 发送+加签：URL#secret（secret 为机器人安全设置中的加签密钥）
// 3. 发送+接收：appKey:appSecret:webhookUrl（Stream 模式接收企业应用机器人消息）
//
// 接收说明：Stream 模式需要企业应用（非个人），入站消息为应用机器人接收的群聊/单聊文本。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';
import { DingTalkStreamReceiver, parseDingTalkEvent } from './dingtalk-stream';
import { dingtalkSign, WebhookChannelAdapter } from './webhook-channel';

/** Stream 配置分隔符（appKey:appSecret:webhookUrl） */
const STREAM_SEPARATOR = ':';

/**
 * 钉钉渠道适配器（webhook 发送 + 可选 Stream 接收）
 */
export class DingTalkAdapter extends WebhookChannelAdapter {
  readonly kind = 'dingtalk';
  readonly displayName = '钉钉';
  readonly implemented = true;
  override readonly configHint: string = 'webhook URL 或 appKey:appSecret:webhookUrl（发送+接收）';

  private streamReceiver: DingTalkStreamReceiver | null = null;
  private streamHandler: ((message: ChannelIncomingMessage) => void) | null = null;

  /** 覆写：token 解析支持 Stream 三元组 */
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
        // 严格判定：appKey 为纯字母数字（钉钉 appKey 形状），webhookUrl 为 http(s) 地址
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

  /** 覆写：connect 后启动 Stream 接收（若配置） */
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

  /** 覆写：订阅入站（Stream 接收转发） */
  override onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.streamHandler = handler;
    return () => {
      this.streamHandler = null;
    };
  }

  /** 覆写：断开时关闭 Stream */
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

  /** 加签：URL 追加 timestamp + sign（HMAC-SHA256 base64 URL 编码） */
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

  /** 导出解析函数（测试直接验证事件解析；适配器转发入口） */
  static parseEvent = parseDingTalkEvent;
}
