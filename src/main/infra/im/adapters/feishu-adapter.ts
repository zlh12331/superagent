// src/main/infra/im/adapters/feishu-adapter.ts
// 飞书群机器人渠道：webhook 发送（markdown）
// ──────────────────────────────────────────────────────────────
// 接入配置（token 格式）：
// - webhook 完整 URL（https://open.feishu.cn/open-apis/bot/v2/hook/xxx）
// 接收：自定义机器人 webhook 仅支持发送；接收需自建应用长连接（appId/appSecret），
//       桌面端本地场景后置标注。
// ──────────────────────────────────────────────────────────────

import { WebhookChannelAdapter } from './webhook-channel';

/** 飞书文本内容上限（官方限制 30KB，保守截断） */
const FEISHU_MAX_CONTENT = 8000;

/**
 * 飞书群机器人适配器（webhook 发送）
 */
export class FeishuAdapter extends WebhookChannelAdapter {
  readonly kind = 'feishu';
  readonly displayName = '飞书';
  readonly implemented = true;

  protected buildPayload(text: string): unknown {
    return {
      msg_type: 'markdown',
      content: {
        text: text.length > FEISHU_MAX_CONTENT ? `${text.slice(0, FEISHU_MAX_CONTENT)}…` : text,
      },
    };
  }
}
