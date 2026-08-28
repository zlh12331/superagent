// src/main/infra/im/adapters/index.ts
// 渠道适配器注册表（新增渠道：实现 IChannelAdapter + 在此注册）
// ──────────────────────────────────────────────────────────────
// 渠道实现状态（实事求是）：
// - telegram：完整实现（Bot API 长轮询，零依赖；收发齐全）
// - dingtalk / wecom / feishu：完整实现（群机器人 webhook 发送；接收需公网回调/长连接，后置）
// - qq：完整实现（官方 Gateway 长连接接收 + 官方 API 发送）
// - wechat：完整实现（iLink 智能机器人：长轮询接收 + 消息发送）
// ──────────────────────────────────────────────────────────────

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
    // 钉钉：群机器人 webhook（发送；加签 URL#secret）；接收需 Stream 模式
    new DingTalkAdapter(),
    // 企业微信：群机器人 webhook（发送）；接收需自建应用回调
    new WecomAdapter(),
    // 飞书：自定义机器人 webhook（发送）；接收需自建应用长连接
    new FeishuAdapter(),
    // QQ：官方机器人（Gateway 长连接接收 + 官方 API 发送）
    new QqAdapter(),
    // 微信：iLink 智能机器人（长轮询接收 + 消息发送，官方服务）
    new WeixinAdapter(),
  ];
}
