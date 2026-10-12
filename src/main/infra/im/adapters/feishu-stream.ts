// feishu-stream.ts：飞书长连接接收——官方 node-sdk WSClient 封装为消息流（SDK 承担重连/心跳）
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

export interface FeishuStreamConfig {
  readonly appId: string;
  readonly appSecret: string;
}

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
    readonly content?: string;
    readonly mentions?: Array<{
      readonly key?: string;
      readonly id?: unknown;
      readonly name?: string;
    }>;
  };
  readonly event?: { readonly type?: string; readonly event_time?: number };
}

export interface ParsedFeishuMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

const BOT_MENTION_PREFIX = '@_user_1';

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

function stripBotMention(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(BOT_MENTION_PREFIX)) {
    return trimmed.slice(BOT_MENTION_PREFIX.length).trim();
  }
  return trimmed;
}

export class FeishuStreamReceiver {
  private readonly appId: string;
  private readonly appSecret: string;

  private readonly eventDispatcherCtor: typeof lark.EventDispatcher;
  private readonly wsClientCtor: typeof lark.WSClient;

  private wsClient: lark.WSClient | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(
    config: FeishuStreamConfig,
    options: {
      EventDispatcherCtor?: typeof lark.EventDispatcher;
      WSClientCtor?: typeof lark.WSClient;
    } = {},
  ) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.eventDispatcherCtor = options.EventDispatcherCtor ?? lark.EventDispatcher;
    this.wsClientCtor = options.WSClientCtor ?? lark.WSClient;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    const eventDispatcher = new this.eventDispatcherCtor({}).register({
      'im.message.receive_v1': (data: unknown) => {
        this.dispatchEvent(data as FeishuMessageEventV1);
      },
    });
    const wsClient = new this.wsClientCtor({
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

  close(): void {
    if (this.wsClient !== null) {
      try {
        void this.wsClient.close();
      } catch {}
      this.wsClient = null;
    }
    this.opened = false;
  }

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
