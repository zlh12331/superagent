// src/main/infra/im/adapters/index.ts
// 渠道适配器注册表（新增渠道：实现 IChannelAdapter + 在此注册）
// ──────────────────────────────────────────────────────────────
// 渠道实现状态（实事求是）：
// - telegram：完整实现（Bot API 长轮询，零依赖）
// - dingtalk / wecom / feishu / qq / wechat：骨架占位（implemented=false），
//   接入需对应开放平台凭证（appKey/secret/webhook），协议差异见各渠道注释
// ──────────────────────────────────────────────────────────────

import type { ChannelKind } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';
import { TelegramAdapter } from './telegram-adapter';

/**
 * 骨架渠道适配器（未实现渠道的统一占位）
 *
 * connect 抛 IM_CHANNEL_NOT_IMPLEMENTED；设置页展示为"待接入"。
 * 真实接入时替换为具体适配器类（参考 telegram-adapter.ts 结构）。
 */
export class SkeletonChannelAdapter implements IChannelAdapter {
  constructor(
    readonly kind: ChannelKind,
    readonly displayName: string,
    private readonly note: string,
  ) {}

  readonly implemented = false;
  readonly isConnected = false;

  async connect(): Promise<void> {
    throw new AppError(ErrorCode.IM_CHANNEL_NOT_IMPLEMENTED, this.note);
  }

  async disconnect(): Promise<void> {
    // 骨架无连接，no-op
  }

  async sendMessage(_target: ChannelTarget, _text: string): Promise<void> {
    throw new AppError(ErrorCode.IM_CHANNEL_NOT_IMPLEMENTED, this.note);
  }

  onMessage(_handler: (message: ChannelIncomingMessage) => void): () => void {
    return () => {};
  }
}

/**
 * 全部渠道适配器实例（设置页列表 + 管理器注册共用）
 */
export function createAllAdapters(): IChannelAdapter[] {
  return [
    new TelegramAdapter(),
    // 钉钉：自定义机器人 webhook 或 Stream 模式（应用凭证 appKey/secret）
    new SkeletonChannelAdapter('dingtalk', '钉钉', '待接入：钉钉开放平台机器人凭证'),
    // 企业微信：群机器人 webhook 或自建应用（corpId/secret）
    new SkeletonChannelAdapter('wecom', '企业微信', '待接入：企业微信自建应用凭证'),
    // 飞书：自定义机器人 webhook 或应用（appId/appSecret）
    new SkeletonChannelAdapter('feishu', '飞书', '待接入：飞书开放平台应用凭证'),
    // QQ：QQ 官方机器人开放平台（appId/token）
    new SkeletonChannelAdapter('qq', 'QQ', '待接入：QQ 机器人开放平台凭证'),
    // 微信：个人微信自动化存在合规风险（官方限制），仅预留架构位
    new SkeletonChannelAdapter('wechat', '微信', '待接入：个人微信自动化受官方限制'),
  ];
}
