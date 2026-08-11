// src/main/infra/im/adapters/qq-stream.ts
// QQ 渠道：官方机器人 API + WebSocket Gateway 协议（对齐 qwen QQChannel 语义收敛）
// ──────────────────────────────────────────────────────────────
// 协议（参考 QQ 官方开放平台 api-v2 文档）：
// 1. access_token：POST bots.qq.com/app/getAppAccessToken {appId, clientSecret}
// 2. WS 网关：wss://api.sgroup.qq.com/websocket（沙箱可注入）
// 3. Gateway 握手：hello(op10, heartbeat_interval) → identify(op2, {token, intents}) → 心跳(op1)
// 4. 事件：op0 dispatch，t ∈ {GROUP_AT_MESSAGE, C2C_MESSAGE} → 文本消息
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/channels/qqbot/src/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// api.ts（accessToken/网关）+ QQChannel.ts（Gateway 协议/消息归一化）语义，按我们的技术栈收敛重写：
// - 移除二维码登录/凭据持久化/跨服务器路由持久化（桌面端由 keychain + 会话映射覆盖）
// - 保留核心：OpCode/Intent 协议帧、消息事件归一化、群/单聊 chatId 区分
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

/** Gateway opcode（官方协议） */
export const QqOpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 事件订阅 intent（官方协议） */
export const QqIntent = {
  // 官方：GROUP_AND_C2C_EVENT (1 << 25) 同时覆盖群聊@消息（GROUP_AT_MESSAGE_CREATE）与单聊（C2C_MESSAGE_CREATE）
  GROUP_AND_C2C_EVENT: 1 << 25,
} as const;

/** QQ 消息事件形状 */
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

/** Gateway 帧 */
export interface QqGatewayFrame {
  readonly op?: number;
  readonly t?: string;
  readonly d?: unknown;
  readonly s?: number;
}

/** 解析结果：null = 非文本消息事件（忽略） */
export interface ParsedQqMessage {
  /** 会话类型（群聊/单聊；回发路由） */
  readonly chatType: 'group' | 'user';
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

/** 网关响应 */
export interface QqGatewayResponse {
  readonly url: string;
}

/**
 * 获取网关地址（官方：GET /gateway/bot，可注入测试）
 */
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

/** accessToken 响应 */
export interface QqTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/** access_token 获取（端点可注入测试） */
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

/**
 * Gateway 事件帧解析（纯函数，可测）
 *
 * 支持：GROUP_AT_MESSAGE（群聊 @ 机器人）/ C2C_MESSAGE（单聊）
 * 群聊 chatId = group_openid；单聊 chatId = user_openid
 * 文本：剥离开头的 <@openid> 机器人 mention 标签，保留其余
 */
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

/** 剥离开头 <@openid> 机器人 mention（群消息 @ 机器人 前缀） */
function stripBotMention(content: string): string {
  const trimmed = content.trim();
  const match = /^<@!?[a-zA-Z0-9_-]+>\s*/.exec(trimmed);
  return match === null ? trimmed : trimmed.slice(match[0].length).trim();
}

/** QQ 长连接配置 */
export interface QqStreamConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** 网关获取端点（测试注入；缺省官方 /gateway/bot） */
  readonly gatewayUrl?: string;
  /** accessToken 端点（测试注入） */
  readonly tokenUrl?: string;
}

/**
 * QQ 长连接接收器（Gateway 协议；生命周期 open/close）
 */
export class QqStreamReceiver {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly gatewayUrl: string;
  private readonly tokenUrl: string;

  /**
   * 外部依赖注入点（测试传 fake，生产默认实现）：
   * - fetchTokenFn / fetchGatewayFn：HTTP（网络）
   * - wsCtor：WebSocket 长连接（网络）
   * - reconnectDelayMs / handshakeTimeoutMs：时间参数（测试缩短）
   */
  private readonly fetchTokenFn: typeof fetchQqAccessToken;
  private readonly fetchGatewayFn: typeof fetchQqGatewayUrl;
  private readonly wsCtor: typeof WebSocket;
  private readonly handshakeTimeoutMs: number;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 最新事件序列号（心跳携带；官方协议要求） */
  private lastSeq: number | null = null;
  /** HEARTBEAT_ACK 超时监控（僵尸连接检测） */
  private ackTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** 手动关闭标记（区分主动关闭与意外断线） */
  private manualClose = false;
  /** 重连退避延迟（毫秒） */
  private reconnectDelayMs = 5_000;
  /** 重连中（防并发重连） */
  private reconnecting = false;
  /** 会话 id（READY 下发；断线 RESUME 恢复用） */
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

  /** 订阅入站消息（单订阅者：适配器转发用） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 打开长连接（token → WS 握手 → 心跳 → 事件监听）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    const { accessToken } = await this.fetchTokenFn(this.appId, this.appSecret, this.tokenUrl);
    const gateway = await this.fetchGatewayFn(accessToken, this.gatewayUrl);
    const ws = new this.wsCtor(gateway);
    this.ws = ws;
    this.manualClose = false;
    // 意外断线（非手动关闭）：自动重连（对齐 qwen 心跳监控/重连语义）
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
    logger.info({}, 'QQ 长连接已建立（接收就绪）');
  }

  /** 计划重连（固定退避；token 有效则持续重试） */
  private scheduleReconnect(): void {
    this.reconnecting = true;
    logger.warn({ delayMs: this.reconnectDelayMs }, 'QQ 长连接断开，计划重连');
    setTimeout(() => {
      this.reconnecting = false;
      void this.open().catch((err: unknown) => {
        logger.error({ error: err }, 'QQ 重连失败，再次计划');
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  /** 关闭长连接（幂等；手动关闭不触发重连） */
  close(): void {
    this.manualClose = true;
    this.clearAckTimeout();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // 关闭失败不阻断
      }
      this.ws = null;
    }
    this.opened = false;
  }

  /** Gateway 握手：hello → identify → 心跳 */
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
            // 断线恢复：RESUME（复用会话，避免消息重播）
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
            // 首次连接：identify（订阅 C2C + 群 @ 消息）
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
          // RESUME 失败（session 失效）：回退 identify（清空 sessionId 走首次流程）
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
          // READY（identify 成功）或 RESUMED（resume 成功）视为握手完成
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

  /** 心跳：Gateway 协议（op1 定期发送 + HEARTBEAT_ACK 超时监控） */
  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ op: QqOpCode.HEARTBEAT, d: this.lastSeq }));
        // 发送后武装 ack 超时（2 倍心跳周期；超时判定僵尸连接 → 强制断开触发重连）
        this.armAckTimeout(ws, intervalMs * 2);
      } catch {
        // 连接关闭时停止心跳
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      }
    }, intervalMs);
  }

  /** 武装 HEARTBEAT_ACK 超时监控 */
  private armAckTimeout(ws: WebSocket, timeoutMs: number): void {
    // 已有 pending 监控（等待 ACK）时不重置（真实缺陷修复：原实现每次心跳都
    // 重新武装，心跳持续发送时计时器被无限重置 → 僵尸连接检测永不触发）
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
      } catch {
        // close 事件触发重连
      }
    }, timeoutMs);
  }

  /** 清除 ack 超时监控 */
  private clearAckTimeout(): void {
    if (this.ackTimeoutTimer !== null) {
      clearTimeout(this.ackTimeoutTimer);
      this.ackTimeoutTimer = null;
    }
  }

  /** 事件分发：记录序列号 + 解析转发 */
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

/** WS 消息 → Gateway 帧（JSON 解析容错） */
function parseFrame(event: MessageEvent): QqGatewayFrame | null {
  try {
    const parsed = JSON.parse(event.data as string) as QqGatewayFrame;
    return typeof parsed.op === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
