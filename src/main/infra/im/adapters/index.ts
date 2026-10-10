import type { IChannelAdapter } from '../channel/types';
import { DingTalkAdapter } from './dingtalk-adapter';
import { FeishuAdapter } from './feishu-adapter';
import { QqAdapter } from './qq-adapter';
import { TelegramAdapter } from './telegram-adapter';
import { WecomAdapter } from './wecom-adapter';
import { WeixinAdapter } from './weixin-adapter';

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
