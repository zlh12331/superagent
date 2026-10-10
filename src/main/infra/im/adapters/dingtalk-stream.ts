// dingtalk-stream.ts：钉钉 Stream 模式——官方 openconnection 换 WebSocket 端点 + 事件解析接收
import { AppError, type ChannelKind, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import { proxiedFetch } from '../../network/proxied-fetch';
import type { ChannelIncomingMessage } from '../channel/types';

export interface DingTalkStreamConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly apiBaseUrl?: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

export interface DingTalkEventFrame {
  readonly type: string;
  readonly headers?: Record<string, string>;
  readonly body?: {
    readonly eventType?: string;
    readonly eventId?: string;
    readonly eventBornTime?: number;
    readonly data?: unknown;
  };
}

interface ChatbotMessageBody {
  readonly senderStaffId?: string;
  readonly senderId?: string;
  readonly conversationId?: string;
  readonly text?: { readonly content?: string };
  readonly content?: string;
  readonly msgId?: string;
  readonly msgtype?: string;
}

export interface ParsedDingTalkMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

function now(): number {
  return Date.now();
}

export function parseDingTalkEvent(frame: DingTalkEventFrame): ParsedDingTalkMessage | null {
  if (frame.type !== 'data' || frame.body === undefined) {
    return null;
  }
  if (frame.body.eventType !== 'ChatbotMessage') {
    return null;
  }
  const data = frame.body.data as ChatbotMessageBody | undefined;
  if (data === undefined || typeof data !== 'object') {
    return null;
  }
  const isText = data.msgtype === 'text' || data.msgtype === undefined;
  if (!isText) {
    return null;
  }
  const text = data.text?.content ?? data.content;
  if (text === undefined || text.trim().length === 0) {
    return null;
  }
  const chatId = data.conversationId ?? 'dingtalk:unknown';
  const senderId = data.senderStaffId ?? data.senderId;
  const messageId = data.msgId ?? `${chatId}:${frame.body.eventId ?? now()}`;
  return {
    text: text.trim(),
    chatId,
    senderId,
    messageId,
    timestamp: frame.body.eventBornTime ?? now(),
  };
}

export class DingTalkStreamReceiver {
  readonly kind: ChannelKind = 'dingtalk';
  private readonly apiBaseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;

  private readonly fetchFn: typeof fetch;
  private readonly wsCtor: typeof WebSocket;
  private readonly httpTimeoutMs: number;
  private readonly heartbeatMs: number;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(
    config: DingTalkStreamConfig,
    options: {
      fetchFn?: typeof fetch;
      WebSocketCtor?: typeof WebSocket;
      timeoutMs?: number;
      heartbeatMs?: number;
    } = {},
  ) {
    this.appKey = config.appKey;
    this.appSecret = config.appSecret;
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.dingtalk.com';
    this.fetchFn = options.fetchFn ?? (proxiedFetch as unknown as typeof fetch);
    this.wsCtor = options.WebSocketCtor ?? WebSocket;
    this.httpTimeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
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
    const accessToken = await this.fetchAccessToken();
    const { endpoint, ticket } = await this.fetchConnection(accessToken);
    const ws = new this.wsCtor(endpoint);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, '钉钉 Stream 连接超时'));
      }, this.httpTimeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'register', ticket }));
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, '钉钉 Stream 连接失败'));
      });
      ws.addEventListener('message', (event) => {
        const frame = parseFrame(event);
        if (frame?.type === 'registered') {
          clearTimeout(timer);
          this.opened = true;
          this.startHeartbeat();
          resolve();
          logger.info({ kind: this.kind }, '钉钉 Stream 已注册（接收就绪）');
        }
        if (frame?.type === 'data') {
          this.dispatchFrame(frame);
        }
      });
    });
  }

  close(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
    this.opened = false;
  }

  private async fetchAccessToken(): Promise<string> {
    const response = await this.postJson(`${this.apiBaseUrl}/v1.0/oauth2/accessToken`, {
      appKey: this.appKey,
      appSecret: this.appSecret,
    });
    const body = response as { accessToken?: string; code?: number; message?: string };
    if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_INVALID_TOKEN,
        `钉钉 Stream 凭证无效：${body.message ?? body.code ?? '未知错误'}`,
      );
    }
    return body.accessToken;
  }

  private async fetchConnection(
    accessToken: string,
  ): Promise<{ endpoint: string; ticket: string }> {
    const response = await this.getJson(
      `${this.apiBaseUrl}/v1.0/gateway/connections/open`,
      accessToken,
    );
    const body = response as {
      code?: number;
      data?: Array<{ endpoint?: string; ticket?: string }>;
    };
    const entry = body.data?.[0];
    if (entry?.endpoint === undefined || entry.ticket === undefined) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_REQUEST_FAILED,
        `钉钉 Stream 网关连接失败：${body.code ?? '未知错误'}`,
      );
    }
    return { endpoint: entry.endpoint, ticket: entry.ticket };
  }

  private async postJson(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.httpTimeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(url: string, accessToken: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.httpTimeoutMs);
    try {
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ type: 'nop' }));
    }, this.heartbeatMs);
  }

  private dispatchFrame(frame: DingTalkEventFrame): void {
    if (frame.type !== 'data') {
      return;
    }
    const parsed = parseDingTalkEvent(frame);
    if (parsed !== null) {
      this.messageHandler?.({
        channel: this.kind,
        chatId: parsed.chatId,
        senderId: parsed.senderId,
        text: parsed.text,
        messageId: parsed.messageId,
        timestamp: parsed.timestamp,
      });
    }
  }
}

function parseFrame(event: MessageEvent): DingTalkEventFrame | null {
  try {
    const parsed = JSON.parse(event.data as string) as DingTalkEventFrame;
    if (typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
