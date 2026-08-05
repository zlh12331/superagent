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
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 事件订阅 intent（官方协议） */
export const QqIntent = {
  C2C_MESSAGE: 1 << 12,
  GROUP_AT_MESSAGE: 1 << 25,
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
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
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
  const isGroup = frame.t === 'GROUP_AT_MESSAGE';
  const isC2C = frame.t === 'C2C_MESSAGE';
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
  /** 网关地址（测试注入；缺省正式环境） */
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

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(config: QqStreamConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.gatewayUrl = config.gatewayUrl ?? 'wss://api.sgroup.qq.com/websocket';
    this.tokenUrl = config.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken';
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
    const { accessToken } = await fetchQqAccessToken(this.appId, this.appSecret, this.tokenUrl);
    const ws = new WebSocket(this.gatewayUrl);
    this.ws = ws;
    await this.handshake(ws, accessToken);
    this.opened = true;
    logger.info({}, 'QQ 长连接已建立（接收就绪）');
  }

  /** 关闭长连接（幂等） */
  close(): void {
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
      }, 15_000);
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, 'QQ 网关连接失败'));
      });
      ws.addEventListener('message', (event) => {
        const frame = parseFrame(event);
        if (frame === null) {
          return;
        }
        if (frame.op === QqOpCode.HELLO) {
          const hello = frame.d as { heartbeat_interval?: number } | undefined;
          const interval = hello?.heartbeat_interval ?? 30_000;
          // identify（订阅 C2C + 群 @ 消息）
          ws.send(
            JSON.stringify({
              op: QqOpCode.IDENTIFY,
              d: {
                token: `QQBot ${accessToken}`,
                intents: QqIntent.C2C_MESSAGE | QqIntent.GROUP_AT_MESSAGE,
              },
            }),
          );
          this.startHeartbeat(ws, interval);
        } else if (frame.op === QqOpCode.DISPATCH) {
          this.dispatchFrame(frame);
          // identify 后首个事件（READY）视为握手完成
          if (frame.t === 'READY') {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
  }

  /** 心跳：Gateway 协议（op1 定期发送） */
  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ op: QqOpCode.HEARTBEAT, d: null }));
      } catch {
        // 连接关闭时停止心跳
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      }
    }, intervalMs);
  }

  /** 事件分发：解析 → 转发入站消息 */
  private dispatchFrame(frame: QqGatewayFrame): void {
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
