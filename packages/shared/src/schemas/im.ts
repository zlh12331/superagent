// packages/shared/src/schemas/im.ts
// IM 渠道集成域（Telegram / 钉钉 / 企业微信 / 飞书 / QQ / 微信）
// ──────────────────────────────────────────────────────────────
// 设计：
// - ChannelKind：渠道枚举（扩展新渠道只需加枚举 + 适配器注册）
// - IChannelInfo：渠道静态信息（展示用，不涉密）
// - 敏感配置（token/secret）不走本 schema：经 keychain 存取（`im:${kind}`）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** IM 渠道枚举（新增渠道：扩展此枚举 + 适配器注册） */
export const ChannelKind = {
  TELEGRAM: 'telegram',
  DINGTALK: 'dingtalk',
  WECOM: 'wecom',
  FEISHU: 'feishu',
  QQ: 'qq',
  WECHAT: 'wechat',
} as const;

export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

/**
 * 渠道静态信息（设置页展示）
 */
export interface IChannelInfo {
  /** 渠道标识 */
  readonly kind: ChannelKind;
  /** 展示名称 */
  readonly displayName: string;
  /** 一句话说明 */
  readonly description: string;
  /** 是否已实现（骨架渠道为 false，仅展示占位） */
  readonly implemented: boolean;
  /** 是否已配置（token 等已存入 keychain） */
  readonly configured: boolean;
  /** 是否运行中 */
  readonly running: boolean;
}

/**
 * im:start 入参 zod schema（渠道启停）
 */
export const ChannelStartReqSchema = z.object({
  kind: z.enum(Object.values(ChannelKind) as [ChannelKind, ...ChannelKind[]]),
  /** 渠道 token（如 Telegram Bot Token；首次启动时提供，之后存 keychain） */
  token: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
});

export type ChannelStartReq = z.infer<typeof ChannelStartReqSchema>;

/**
 * im:stop 入参 zod schema
 */
export const ChannelStopReqSchema = z.object({
  kind: z.enum(Object.values(ChannelKind) as [ChannelKind, ...ChannelKind[]]),
});

export type ChannelStopReq = z.infer<typeof ChannelStopReqSchema>;

/** im:start / im:stop 响应 payload */
export interface ChannelOpRes {
  readonly ok: boolean;
}

/**
 * IM 渠道列表响应（IPC im:list）
 */
export interface ChannelListRes {
  readonly channels: readonly IChannelInfo[];
}
