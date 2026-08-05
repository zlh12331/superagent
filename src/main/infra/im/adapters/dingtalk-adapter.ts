// src/main/infra/im/adapters/dingtalk-adapter.ts
// 钉钉群机器人渠道：webhook 发送（markdown；可选加签）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式）：
// - 无加签：webhook 完整 URL（https://oapi.dingtalk.com/robot/send?access_token=xxx）
// - 加签：URL#secret（secret 为机器人安全设置中的加签密钥）
// 接收：群机器人 webhook 仅支持发送；接收需钉钉 Stream 模式（企业应用凭证），
//       桌面端本地场景后置标注。
// ──────────────────────────────────────────────────────────────

import { dingtalkSign, WebhookChannelAdapter } from './webhook-channel';

/**
 * 钉钉群机器人适配器（webhook 发送）
 */
export class DingTalkAdapter extends WebhookChannelAdapter {
  readonly kind = 'dingtalk';
  readonly displayName = '钉钉';
  readonly implemented = true;

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
}
