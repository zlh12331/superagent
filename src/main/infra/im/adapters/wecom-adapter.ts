// src/main/infra/im/adapters/wecom-adapter.ts
// 企业微信群机器人渠道：webhook 发送（markdown）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式）：
// - webhook 完整 URL（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx）
// 接收：群机器人 webhook 仅支持发送；接收需自建应用回调（corpId/secret + 公网回调 URL），
//       桌面端本地场景后置标注。
// ──────────────────────────────────────────────────────────────

import { WebhookChannelAdapter } from './webhook-channel';

/** 企业微信 markdown 内容上限（官方限制 4096 字节） */
const WECOM_MAX_CONTENT = 4000;

/**
 * 企业微信群机器人适配器（webhook 发送）
 */
export class WecomAdapter extends WebhookChannelAdapter {
  readonly kind = 'wecom';
  readonly displayName = '企业微信';
  readonly implemented = true;

  protected buildPayload(text: string): unknown {
    return {
      msgtype: 'markdown',
      markdown: {
        content: text.length > WECOM_MAX_CONTENT ? `${text.slice(0, WECOM_MAX_CONTENT)}…` : text,
      },
    };
  }
}
