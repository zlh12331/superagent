// src/main/infra/im/channel/types.ts
// IM 渠道抽象（领域层，零依赖）
// ──────────────────────────────────────────────────────────────
// 职责：
// - IChannelAdapter：渠道统一接口（连接/收消息/回发/生命周期）
// - ChannelIncomingMessage：入站消息（渠道无关的领域形状）
// - ChannelTarget：回发目标（chatId 维度）
//
// 设计（对齐"低耦合高内聚"）：
// - 适配器只负责"渠道协议"：连接、接收、回发；不感知 agent/会话
// - 消息 → agent 的桥接由 im-service（桥接层）负责，适配器保持纯净
// - 回发是异步 fire-and-forget：失败由适配器内部重试/降级，不阻塞主流程
// ──────────────────────────────────────────────────────────────

import type { ChannelKind } from '@code-agent/shared/main';

/**
 * 入站消息（渠道无关领域形状）
 */
export interface ChannelIncomingMessage {
  /** 来源渠道 */
  readonly channel: ChannelKind;
  /** 会话/聊天标识（Telegram chatId / 钉钉 conversationId 等） */
  readonly chatId: string;
  /** 发送者标识（telegram userId 等；匿名渠道可为空） */
  readonly senderId: string | undefined;
  /** 消息文本（已剥离 @bot 前缀等渠道杂讯） */
  readonly text: string;
  /** 渠道原始消息 id（去重用） */
  readonly messageId: string;
  /** 接收时间 */
  readonly timestamp: number;
}

/**
 * 回发目标（chatId 维度）
 */
export interface ChannelTarget {
  /** 目标会话/聊天标识 */
  readonly chatId: string;
}

/**
 * 渠道适配器接口
 *
 * 实现约定：
 * - connect 幂等：重复调用返回已连接状态；token 无效抛错（AppError 分类）
 * - disconnect 可重入：未连接时 no-op
 * - onMessage 返回 unsubscribe；disconnect 时自动清理
 * - sendMessage 失败（网络/限流）由适配器内部重试（最多 2 次退避），仍失败则记录日志
 */
export interface IChannelAdapter {
  /** 渠道标识 */
  readonly kind: ChannelKind;
  /** 展示名称 */
  readonly displayName: string;
  /** 是否已实现（骨架渠道为 false） */
  readonly implemented: boolean;
  /** 是否已连接 */
  readonly isConnected: boolean;

  /**
   * 建立连接（Telegram：验证 token + 启动长轮询）
   *
   * @param token 渠道 token（首次启动时传入；之后走 keychain）
   */
  connect(token: string | undefined): Promise<void>;

  /** 断开连接（停止轮询/关闭连接，清理监听） */
  disconnect(): Promise<void>;

  /**
   * 回发消息（fire-and-forget 语义由调用方掌控，本方法等待发送结果）
   */
  sendMessage(target: ChannelTarget, text: string): Promise<void>;

  /**
   * 订阅入站消息（返回取消订阅函数）
   */
  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void;
}
