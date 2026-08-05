// src/main/infra/im/adapters/feishu-stream.ts
// 飞书长连接接收器：官方 SDK WSClient（对齐 qwen FeishuChannel 语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计（参考 qwen channels/feishu 架构）：
// - SDK 管理 tenant_access_token / 心跳 / 重连（生产级连接层）
// - 事件分发：im.message.receive_v1 → parseFeishuEvent（纯函数可测）→ 入站消息
// - 消息类型：text（文本）；post（富文本含文本）；其余（图片/文件）忽略
// - @bot 前缀剥离：群聊 mention 场景
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/channels/feishu/src/FeishuAdapter.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 长连接接入与消息解析语义，按我们的技术栈收敛重写：
// - 移除交互卡片（卡片状态机/停止按钮，桌面端由既有审批/推送覆盖）
// - 移除 media 下载（保留扩展位）；事件解析收敛为纯函数
// - 保留核心：SDK WSClient 长连接 + 消息事件归一化
// ──────────────────────────────────────────────────────────────

import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

/** 飞书长连接配置 */
export interface FeishuStreamConfig {
  readonly appId: string;
  readonly appSecret: string;
}

/** 飞书 im.message.receive_v1 事件形状（SDK 解耦：自定义宽松类型） */
export interface FeishuMessageEventV1 {
  readonly sender?: {
    readonly sender_id?: {
      readonly open_id?: string;
      readonly union_id?: string;
      readonly user_id?: string;
    };
    readonly sender_type?: string;
  };
  readonly message?: {
    readonly message_id?: string;
    readonly chat_id?: string;
    readonly chat_type?: string;
    readonly message_type?: string;
    readonly content?: string; // JSON 字符串
    readonly mentions?: Array<{
      readonly key?: string;
      readonly id?: unknown;
      readonly name?: string;
    }>;
  };
  readonly event?: { readonly type?: string; readonly event_time?: number };
}

/** 解析结果：null = 非文本消息（忽略） */
export interface ParsedFeishuMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

/** @bot mention key 前缀（群聊中 @机器人 的标记） */
const BOT_MENTION_PREFIX = '@_user_1';

/**
 * 飞书消息事件解析（纯函数，可测）
 *
 * 支持：text 消息（content JSON {text}）；post 消息（富文本，取纯文本拼接）
 * 忽略：图片/文件/音频等（消息体无文本语义）
 */
export function parseFeishuEvent(event: FeishuMessageEventV1): ParsedFeishuMessage | null {
  const message = event.message;
  if (message === undefined || message.message_type === undefined) {
    return null;
  }
  let text: string | null = null;
  if (message.message_type === 'text') {
    text = parseTextContent(message.content);
  } else if (message.message_type === 'post') {
    text = parsePostContent(message.content);
  }
  if (text === null || text.trim().length === 0) {
    return null;
  }
  // 剥离 @bot 前缀（mention 场景：'@_user_1 帮我xxx' → '帮我xxx'）
  const cleaned = stripBotMention(text);
  if (cleaned.length === 0) {
    return null;
  }
  const senderId =
    event.sender?.sender_id?.open_id ??
    event.sender?.sender_id?.union_id ??
    event.sender?.sender_id?.user_id;
  return {
    text: cleaned,
    chatId: message.chat_id ?? 'feishu:unknown',
    senderId,
    messageId:
      message.message_id ??
      `${message.chat_id ?? 'feishu'}:${event.event?.event_time ?? Date.now()}`,
    timestamp: event.event?.event_time ?? Date.now(),
  };
}

/** text 消息 content（JSON 字符串 → {text}） */
function parseTextContent(content: string | undefined): string | null {
  if (content === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/** post 消息 content（JSON → 富文本段落拼接纯文本） */
function parsePostContent(content: string | undefined): string | null {
  if (content === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<Array<{ tag?: string; text?: string; un_link?: string }>>;
    };
    const parts: string[] = [];
    for (const line of parsed.content ?? []) {
      for (const node of line) {
        if (node.tag === 'text' && typeof node.text === 'string') {
          parts.push(node.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  } catch {
    return null;
  }
}

/** 剥离 @bot mention 前缀 */
function stripBotMention(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(BOT_MENTION_PREFIX)) {
    return trimmed.slice(BOT_MENTION_PREFIX.length).trim();
  }
  return trimmed;
}

/**
 * 飞书长连接接收器（SDK WSClient；生命周期 open/close）
 */
export class FeishuStreamReceiver {
  private readonly appId: string;
  private readonly appSecret: string;
  private wsClient: lark.WSClient | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(config: FeishuStreamConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 订阅入站消息（单订阅者：适配器转发用） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 打开长连接（SDK 自动管理 token/心跳/重连）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        this.dispatchEvent(data as FeishuMessageEventV1);
      },
    });
    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.error,
    });
    try {
      await wsClient.start({ eventDispatcher });
    } catch (err: unknown) {
      logger.error({ error: err }, '飞书长连接启动失败');
      throw err;
    }
    this.wsClient = wsClient;
    this.opened = true;
    logger.info({}, '飞书长连接已建立（接收就绪）');
  }

  /** 关闭长连接（幂等） */
  close(): void {
    if (this.wsClient !== null) {
      try {
        void this.wsClient.close();
      } catch {
        // 关闭失败不阻断
      }
      this.wsClient = null;
    }
    this.opened = false;
  }

  /** 事件分发：解析 → 转发入站消息 */
  private dispatchEvent(event: FeishuMessageEventV1): void {
    const parsed = parseFeishuEvent(event);
    if (parsed === null) {
      return;
    }
    this.messageHandler?.({
      channel: 'feishu',
      chatId: parsed.chatId,
      senderId: parsed.senderId,
      text: parsed.text,
      messageId: parsed.messageId,
      timestamp: parsed.timestamp,
    });
  }
}
