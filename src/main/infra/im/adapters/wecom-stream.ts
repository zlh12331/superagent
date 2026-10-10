import { WSClient } from '@wecom/aibot-node-sdk';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

export interface WecomStreamConfig {
  readonly botId: string;
  readonly secret: string;
}

export interface ParsedWecomMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly timestamp: number;
}

type RecordLike = Record<string, unknown>;

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

  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

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

  close(): void {
    if (this.client !== null) {
      try {
        this.client.disconnect();
      } catch {}
      this.client = null;
    }
    this.opened = false;
  }

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
