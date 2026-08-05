// src/main/infra/im/adapters/wecom-stream.ts
// 企业微信长连接接收器：官方 aibot SDK WSClient（对齐 qwen WeComAdapter 语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计（参考 qwen channels/wecom 架构）：
// - SDK 管理认证/心跳/指数退避重连（生产级连接层）
// - 消息事件：'message' 帧 → parseWecomEvent（纯函数可测）→ 入站消息
// - 文本提取：text.content → voice.content → mixed 图文混排拼接 → 媒体占位
// - 群聊 chatid 优先；单聊 chatid 缺省 senderId
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/channels/wecom/src/WeComAdapter.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// extractBody/extractText 消息解析语义，按我们的技术栈收敛重写：
// - 移除媒体下载/去重窗口/断线回退调度（SDK 已内置重连；去重由桥接层负责）
// - 保留核心：payload 归一化 + 多类型文本提取
// ──────────────────────────────────────────────────────────────

import { WSClient } from '@wecom/aibot-node-sdk';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

/** 企业微信长连接配置 */
export interface WecomStreamConfig {
  readonly botId: string;
  readonly secret: string;
}

/** 解析结果：null = 无法归一化（缺 sender/chatId 或无文本） */
export interface ParsedWecomMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly timestamp: number;
}

/** 宽松记录类型（SDK 解耦） */
type RecordLike = Record<string, unknown>;

/**
 * 企业微信消息帧解析（纯函数，可测）
 *
 * payload 形状（aibot 协议）：{ body?: { msgid, from:{userid}, chattype, chatid, msgtype, text:{content}, ... } }
 */
export function parseWecomEvent(payload: unknown): ParsedWecomMessage | null {
  const raw = asRecord(payload);
  if (raw === undefined) {
    return null;
  }
  const body = getRecord(raw, 'body') ?? raw;
  if (body === undefined) {
    return null;
  }
  const msgId = getString(body, 'msgid');
  const senderId = getString(getRecord(body, 'from'), 'userid');
  if (senderId.length === 0) {
    return null;
  }
  const isGroup = getString(body, 'chattype') === 'group';
  const rawChatId = getString(body, 'chatid');
  const chatId = isGroup ? rawChatId : rawChatId || senderId;
  if (chatId.length === 0) {
    return null;
  }
  const text = extractWecomText(body);
  if (text.length === 0) {
    return null;
  }
  return {
    text,
    chatId,
    senderId,
    messageId: msgId.length > 0 ? msgId : `${chatId}:${Date.now()}`,
    timestamp: Date.now(),
  };
}

/** 文本提取（对齐 qwen extractText 语义收敛）：text → voice → mixed 拼接 → 媒体占位 */
function extractWecomText(body: RecordLike): string {
  const msgType = getString(body, 'msgtype');
  if (msgType === 'mixed') {
    const items = getArray(getRecord(body, 'mixed'), 'msg_item');
    const parts = items
      .map((item) => {
        const record = asRecord(item);
        if (record === undefined) {
          return '';
        }
        const itemType = getString(record, 'msgtype');
        if (itemType === 'text') {
          return getString(getRecord(record, 'text'), 'content');
        }
        if (itemType === 'voice') {
          return getString(getRecord(record, 'voice'), 'content');
        }
        return '';
      })
      .filter((part) => part.length > 0);
    return parts.join('\n').trim();
  }
  const text = getString(getRecord(body, 'text'), 'content');
  if (text.length > 0) {
    return text;
  }
  const voiceText = getString(getRecord(body, 'voice'), 'content');
  if (voiceText.length > 0) {
    return voiceText;
  }
  // 媒体占位（对齐 qwen：agent 可感知媒体消息存在）
  if (msgType === 'image') {
    return '(image)';
  }
  if (msgType === 'voice') {
    return '(voice)';
  }
  if (msgType === 'video') {
    return '(video)';
  }
  if (msgType === 'file') {
    const name = getString(getRecord(body, 'file'), 'filename');
    return `(file: ${name || 'file'})`;
  }
  return '';
}

/** 类型安全取值（对齐 qwen getString/getRecord 语义） */
function getString(value: RecordLike | undefined, key: string): string {
  const raw = value?.[key];
  return typeof raw === 'string' ? raw : '';
}

function getRecord(value: RecordLike | undefined, key: string): RecordLike | undefined {
  return asRecord(value?.[key]);
}

function getArray(value: RecordLike | undefined, key: string): unknown[] {
  const raw = value?.[key];
  return Array.isArray(raw) ? raw : [];
}

function asRecord(value: unknown): RecordLike | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined;
}

/**
 * 企业微信长连接接收器（SDK WSClient；生命周期 open/close）
 */
export class WecomStreamReceiver {
  private readonly botId: string;
  private readonly secret: string;
  private client: WSClient | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(config: WecomStreamConfig) {
    this.botId = config.botId;
    this.secret = config.secret;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 订阅入站消息（单订阅者：适配器转发用） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 打开长连接（SDK 自动认证/心跳/重连）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    const client = new WSClient({
      botId: this.botId,
      secret: this.secret,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => logger.warn({ message }, '企业微信 SDK'),
        error: (message: string) => logger.error({ message }, '企业微信 SDK'),
      },
    });
    client
      .connect()
      .on('message', (frame: unknown) => {
        this.dispatchFrame(frame);
      })
      .on('error', (err: unknown) => {
        logger.error({ error: err }, '企业微信长连接错误');
      });
    this.client = client;
    this.opened = true;
    logger.info({}, '企业微信长连接已建立（接收就绪）');
  }

  /** 关闭长连接（幂等） */
  close(): void {
    if (this.client !== null) {
      try {
        this.client.disconnect();
      } catch {
        // 关闭失败不阻断
      }
      this.client = null;
    }
    this.opened = false;
  }

  /** 帧分发：解析 → 转发入站消息 */
  private dispatchFrame(frame: unknown): void {
    const parsed = parseWecomEvent(frame);
    if (parsed === null) {
      return;
    }
    this.messageHandler?.({
      channel: 'wecom',
      chatId: parsed.chatId,
      senderId: parsed.senderId,
      text: parsed.text,
      messageId: parsed.messageId,
      timestamp: parsed.timestamp,
    });
  }
}
