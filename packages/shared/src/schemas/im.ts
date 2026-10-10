// im.ts：IM 渠道集成域 IPC 契约单一真源——渠道枚举 + im:list / im:start / im:stop 的入参与响应形状，
// 由 packages/shared/src/ipc/definitions.ts 引用做运行时校验。
// 边界：token 等敏感配置不进本文件（主进程经 keychain 存取，key 约定 `im:${kind}`）；新增渠道 = 扩展 ChannelKind + 注册适配器。

import { z } from 'zod';

// ────────── 渠道枚举与展示模型 ──────────

/** IM 渠道枚举（新增渠道：扩展此枚举 + 适配器注册）——wecom = 企业微信、wechat = 微信，勿混 */
export const ChannelKind = {
  TELEGRAM: 'telegram',
  DINGTALK: 'dingtalk',
  WECOM: 'wecom',
  FEISHU: 'feishu',
  QQ: 'qq',
  WECHAT: 'wechat',
} as const;

/** ChannelKind 的联合字面量类型（由常量对象派生，新增渠道无需手工维护） */
export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

/**
 * 渠道静态信息（im:list 响应条目，设置页展示用）
 */
export interface IChannelInfo {
  /** 渠道标识 */
  readonly kind: ChannelKind;
  /** 展示名称 */
  readonly displayName: string;
  /** 设置页说明文案（取适配器 configHint；未接入渠道为「待接入：…」前缀） */
  readonly description: string;
  /** 是否已实现——false 为骨架占位：设置页禁用启动按钮，说明显示「待接入：…」 */
  readonly implemented: boolean;
  /** 是否已配置（keychain 中已存该渠道 token；与 running 独立） */
  readonly configured: boolean;
  /** 是否运行中（取自主进程「已启动」集合：某轮 start 成功且尚未 stop，不代表此刻连接仍然存活） */
  readonly running: boolean;
}

// ────────── IPC 契约（请求入参 schema 与响应 payload） ──────────

/**
 * im:start 入参 zod schema
 *
 * token 首次启动时随请求提供（主进程随即写入 keychain）；省略则读 keychain 已有值，都没有则启动失败。
 */
export const ChannelStartReqSchema = z.object({
  kind: z.enum(Object.values(ChannelKind) as [ChannelKind, ...ChannelKind[]]),
  /** 渠道 token（如 Telegram Bot Token）；空串被 min(1) 拒绝——调用方应省略该字段而非传空串 */
  token: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
});

/** im:start 入参类型（由 schema 派生；token 缺省 = 走 keychain） */
export type ChannelStartReq = z.infer<typeof ChannelStartReqSchema>;

/**
 * im:stop 入参 zod schema（幂等：停止未运行的渠道不报错）
 */
export const ChannelStopReqSchema = z.object({
  kind: z.enum(Object.values(ChannelKind) as [ChannelKind, ...ChannelKind[]]),
});

/** im:stop 入参类型（由 schema 派生） */
export type ChannelStopReq = z.infer<typeof ChannelStopReqSchema>;

/** im:start / im:stop 响应 payload（ok 表示操作已受理；失败经 IpcResponse.error 上报，不返回 ok:false） */
export interface ChannelOpRes {
  readonly ok: boolean;
}

/**
 * IM 渠道列表响应（IPC im:list）
 */
export interface ChannelListRes {
  /** 渠道列表，顺序 = 适配器注册顺序（src/main/infra/im/adapters/index.ts） */
  readonly channels: readonly IChannelInfo[];
}

/**
 * im:list 响应 zod schema（响应契约校验：注册层比对 handler 返回值，防手写 Res 接口漂移）
 *
 * 形状须与 IChannelInfo 手工同步——interface 无法反向派生 schema。
 */
export const ChannelListResSchema = z.object({
  channels: z.array(
    z.object({
      kind: z.enum(Object.values(ChannelKind) as [ChannelKind, ...ChannelKind[]]),
      displayName: z.string(),
      description: z.string(),
      implemented: z.boolean(),
      configured: z.boolean(),
      running: z.boolean(),
    }),
  ),
});
