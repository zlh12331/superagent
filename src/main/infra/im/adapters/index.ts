import type { IChannelAdapter } from '../channel/types';
import { DingTalkAdapter } from './dingtalk-adapter';
import { FeishuAdapter } from './feishu-adapter';
import { QqAdapter } from './qq-adapter';
import { TelegramAdapter } from './telegram-adapter';
import { WecomAdapter } from './wecom-adapter';
import { WeixinAdapter } from './weixin-adapter';

/**
 * 全部渠道适配器实例（设置页列表 + 管理器注册共用）
 */
export function createAllAdapters(): IChannelAdapter[] {
  return [
    new TelegramAdapter(),
    new DingTalkAdapter(),
    new WecomAdapter(),
    new FeishuAdapter(),
    new QqAdapter(),
    new WeixinAdapter(),
  ];
}
