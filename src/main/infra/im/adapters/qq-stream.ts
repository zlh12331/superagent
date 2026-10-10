import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

export const QqOpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const QqIntent = {
  GROUP_AND_C2C_EVENT: 1 << 25,
} as const;

const RECONNECT_MAX_DELAY_MS = 60_000;

const RECONNECT_MAX_ATTEMPTS = 10;

export interface QqMessageEvent {
  readonly id: string;
  readonly author?: {
    readonly user_openid?: string;
    readonly member_openid?: string;
  };
  readonly content: string;
  readonly group_openid?: string;
  readonly mentions?: Array<{ readonly id?: string; readonly is_you?: boolean }>;
}

export interface QqGatewayFrame {
  readonly op?: number;
  readonly t?: string;
  readonly d?: unknown;
  readonly s?: number;
}

export interface ParsedQqMessage {
  readonly chatType: 'group' | 'user';
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

export async function fetchQqGatewayUrl(
  accessToken: string,
  gatewayUrl = 'https://api.sgroup.qq.com/gateway/bot',
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 15_000);
  try {
    const response = await fetch(gatewayUrl, {
      headers: { Authorization: `QQBot ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_REQUEST_FAILED,
        `QQ 网关获取失败（HTTP ${response.status}）`,
      );
    }
    const data = (await response.json()) as { url?: string };
    if (typeof data.url !== 'string' || data.url.length === 0) {
      throw new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, 'QQ 网关响应缺少 url');
    }
    return data.url;
  } finally {
    clearTimeout(timer);
  }
}

export interface QqTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export async function fetchQqAccessToken(
  appId: string,
  appSecret: string,
  tokenUrl = 'https://bots.qq.com/app/getAppAccessToken',
): Promise<QqTokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 15_000);
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_INVALID_TOKEN,
        `QQ 凭证无效（HTTP ${response.status}）`,
      );
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new AppError(ErrorCode.IM_CHANNEL_INVALID_TOKEN, 'QQ 响应缺少 access_token');
    }
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in ?? 7200,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseQqEvent(frame: QqGatewayFrame): ParsedQqMessage | null {
  if (frame.op !== QqOpCode.DISPATCH || typeof frame.t !== 'string') {
    return null;
  }
  const isGroup = frame.t === 'GROUP_AT_MESSAGE_CREATE';
  const isC2C = frame.t === 'C2C_MESSAGE_CREATE';
  if (!isGroup && !isC2C) {
    return null;
  }
  const data = frame.d as QqMessageEvent | undefined;
  if (data === undefined || typeof data.content !== 'string') {
    return null;
  }
  const chatId = isGroup
    ? (data.group_openid ?? 'qq:group:unknown')
    : (data.author?.user_openid ?? 'qq:user:unknown');
  const senderId = isGroup ? data.author?.member_openid : data.author?.user_openid;
  const text = stripBotMention(data.content);
  if (text.length === 0) {
    return null;
  }
  return {
    chatType: isGroup ? 'group' : 'user',
    text,
    chatId,
    senderId,
    messageId: data.id,
    timestamp: Date.now(),
  };
}

function stripBotMention(content: string): string {
  const trimmed = content.trim();
  const match = /^<@!?[a-zA-Z0-9_-]+>\s*/.exec(trimmed);
  return match === null ? trimmed : trimmed.slice(match[0].length).trim();
}

export interface QqStreamConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly gatewayUrl?: string;
  readonly tokenUrl?: string;
}

export class QqStreamReceiver {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly gatewayUrl: string;
  private readonly tokenUrl: string;

  private readonly fetchTokenFn: typeof fetchQqAccessToken;
  private readonly fetchGatewayFn: typeof fetchQqGatewayUrl;
  private readonly wsCtor: typeof WebSocket;
  private readonly handshakeTimeoutMs: number;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeq: number | null = null;
  private ackTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private reconnectDelayMs = 5_000;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(
    config: QqStreamConfig,
    options: {
      fetchTokenFn?: typeof fetchQqAccessToken;
      fetchGatewayFn?: typeof fetchQqGatewayUrl;
      WebSocketCtor?: typeof WebSocket;
      reconnectDelayMs?: number;
      handshakeTimeoutMs?: number;
    } = {},
  ) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.gatewayUrl = config.gatewayUrl ?? 'https://api.sgroup.qq.com/gateway/bot';
    this.tokenUrl = config.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken';
    this.fetchTokenFn = options.fetchTokenFn ?? fetchQqAccessToken;
    this.fetchGatewayFn = options.fetchGatewayFn ?? fetchQqGatewayUrl;
    this.wsCtor = options.WebSocketCtor ?? WebSocket;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
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
    const { accessToken } = await this.fetchTokenFn(this.appId, this.appSecret, this.tokenUrl);
    const gateway = await this.fetchGatewayFn(accessToken, this.gatewayUrl);
    const ws = new this.wsCtor(gateway);
    this.ws = ws;
    this.manualClose = false;
    ws.addEventListener('close', () => {
      this.ws = null;
      this.opened = false;
      if (this.heartbeatTimer !== null) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.clearAckTimeout();
      if (!this.manualClose && !this.reconnecting) {
        this.scheduleReconnect();
      }
    });
    await this.handshake(ws, accessToken);
    this.opened = true;
    this.reconnectAttempts = 0;
    logger.info({}, 'QQ 长连接已建立（接收就绪）');
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'QQ 长连接重连次数达上限，停止重试（请检查网络或 token）',
      );
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    logger.warn(
      { delayMs, attempt: this.reconnectAttempts },
      'QQ 长连接断开，计划重连（指数退避）',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      void this.open().catch((err: unknown) => {
        logger.error({ error: err }, 'QQ 重连失败，再次计划');
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.clearAckTimeout();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.opened = false;
  }

  private handshake(ws: WebSocket, accessToken: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, 'QQ 网关握手超时'));
      }, this.handshakeTimeoutMs);
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, 'QQ 网关连接失败'));
      });
      ws.addEventListener('message', (event) => {
        const frame = parseFrame(event);
        if (frame === null) {
          return;
        }
        if (frame.op === QqOpCode.HEARTBEAT_ACK) {
          this.clearAckTimeout();
        } else if (frame.op === QqOpCode.HELLO) {
          const hello = frame.d as { heartbeat_interval?: number } | undefined;
          const interval = hello?.heartbeat_interval ?? 30_000;
          if (this.sessionId !== null) {
            ws.send(
              JSON.stringify({
                op: QqOpCode.RESUME,
                d: {
                  token: `QQBot ${accessToken}`,
                  session_id: this.sessionId,
                  seq: this.lastSeq,
                },
              }),
            );
            this.startHeartbeat(ws, interval);
          } else {
            ws.send(
              JSON.stringify({
                op: QqOpCode.IDENTIFY,
                d: {
                  token: `QQBot ${accessToken}`,
                  intents: QqIntent.GROUP_AND_C2C_EVENT,
                  shard: [0, 1],
                  properties: {
                    $os: 'windows',
                    $browser: 'code-agent-desktop',
                    $device: 'code-agent-desktop',
                  },
                },
              }),
            );
            this.startHeartbeat(ws, interval);
          }
        } else if (frame.op === QqOpCode.INVALID_SESSION) {
          logger.warn({}, 'QQ RESUME 失败（INVALID_SESSION），回退 identify');
          this.sessionId = null;
          this.lastSeq = null;
          ws.send(
            JSON.stringify({
              op: QqOpCode.IDENTIFY,
              d: {
                token: `QQBot ${accessToken}`,
                intents: QqIntent.GROUP_AND_C2C_EVENT,
                shard: [0, 1],
                properties: {
                  $os: 'windows',
                  $browser: 'code-agent-desktop',
                  $device: 'code-agent-desktop',
                },
              },
            }),
          );
        } else if (frame.op === QqOpCode.DISPATCH) {
          this.dispatchFrame(frame);
          if (frame.t === 'READY') {
            const ready = frame.d as { session_id?: string } | undefined;
            if (typeof ready?.session_id === 'string') {
              this.sessionId = ready.session_id;
            }
            clearTimeout(timer);
            resolve();
          } else if (frame.t === 'RESUMED') {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ op: QqOpCode.HEARTBEAT, d: this.lastSeq }));
        this.armAckTimeout(ws, intervalMs * 2);
      } catch {
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      }
    }, intervalMs);
  }

  private armAckTimeout(ws: WebSocket, timeoutMs: number): void {
    if (this.ackTimeoutTimer !== null) {
      return;
    }
    this.ackTimeoutTimer = setTimeout(() => {
      if (this.manualClose) {
        return;
      }
      logger.warn({ timeoutMs }, 'QQ HEARTBEAT_ACK 超时，判定僵尸连接，强制断开');
      try {
        ws.close();
      } catch {}
    }, timeoutMs);
  }

  private clearAckTimeout(): void {
    if (this.ackTimeoutTimer !== null) {
      clearTimeout(this.ackTimeoutTimer);
      this.ackTimeoutTimer = null;
    }
  }

  private dispatchFrame(frame: QqGatewayFrame): void {
    if (typeof frame.s === 'number') {
      this.lastSeq = frame.s;
    }
    const parsed = parseQqEvent(frame);
    if (parsed === null) {
      return;
    }
    this.messageHandler?.({
      channel: 'qq',
      chatId: parsed.chatId,
      senderId: parsed.senderId,
      text: parsed.text,
      messageId: parsed.messageId,
      timestamp: parsed.timestamp,
    });
  }
}

function parseFrame(event: MessageEvent): QqGatewayFrame | null {
  try {
    const parsed = JSON.parse(event.data as string) as QqGatewayFrame;
    return typeof parsed.op === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
