// src/main/infra/im/adapters/dingtalk-stream.ts
// 钉钉 Stream 模式接收器：企业应用长连接（对齐钉钉开放平台 Stream 协议收敛）
// ──────────────────────────────────────────────────────────────
// 协议流程（钉钉开放平台文档）：
// 1. POST /v1.0/oauth2/accessToken（appKey/appSecret）→ accessToken
// 2. GET  /v1.0/gateway/connections/open（Bearer token）→ { endpoint, ticket }
// 3. WebSocket 连接 endpoint → 发 register 帧（ticket）→ 收 registered
// 4. 收 data 帧（事件体）→ 解析为 ChannelIncomingMessage
// 5. 心跳：每 30s 发 nop 帧（对齐网关保活要求）
//
// 设计：
// - apiBaseUrl 可注入（测试用本地 HTTP 服务器；生产默认钉钉网关）
// - 帧解析（parseDingTalkEvent）为纯函数（导出可测）
// - 失败分类：token 无效 → IM_CHANNEL_INVALID_TOKEN；网络 → IM_CHANNEL_REQUEST_FAILED
// - WS 层用 Node 22+ 全局 WebSocket（零依赖）
// ──────────────────────────────────────────────────────────────

import { AppError, type ChannelKind, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

/** 钉钉 Stream 配置 */
export interface DingTalkStreamConfig {
  readonly appKey: string;
  readonly appSecret: string;
  /** 网关基地址（测试注入；缺省钉钉官方） */
  readonly apiBaseUrl?: string;
}

/** 心跳间隔（毫秒；网关保活要求） */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** HTTP 超时（毫秒） */
const HTTP_TIMEOUT_MS = 10_000;

/** 钉钉事件帧（协议形状） */
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

/** 文本消息事件体（chatbot 回调形状） */
interface ChatbotMessageBody {
  readonly senderStaffId?: string;
  readonly senderId?: string;
  readonly conversationId?: string;
  readonly text?: { readonly content?: string };
  readonly content?: string;
  readonly msgId?: string;
  readonly msgtype?: string;
}

/** 解析结果：null = 非文本消息事件（忽略） */
export interface ParsedDingTalkMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly messageId: string;
  readonly timestamp: number;
}

/** 当前时间戳（可测性：非必要不注入） */
function now(): number {
  return Date.now();
}

/**
 * 钉钉 Stream 事件帧解析（纯函数，可测）
 *
 * 支持的事件：
 * - ChatbotMessage（群聊机器人消息）：data.msgtype === 'text'
 * - 其余事件（成员加入/审批等）返回 null（忽略）
 */
export function parseDingTalkEvent(frame: DingTalkEventFrame): ParsedDingTalkMessage | null {
  if (frame.type !== 'data' || frame.body === undefined) {
    return null;
  }
  // 仅处理机器人消息事件（其余事件类型忽略）
  if (frame.body.eventType !== 'ChatbotMessage') {
    return null;
  }
  const data = frame.body.data as ChatbotMessageBody | undefined;
  if (data === undefined || typeof data !== 'object') {
    return null;
  }
  // 文本消息判定：msgtype 或 content 形状
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

/**
 * 钉钉 Stream 接收器（长连接；生命周期 open/close）
 */
export class DingTalkStreamReceiver {
  readonly kind: ChannelKind = 'dingtalk';
  private readonly apiBaseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private opened = false;

  constructor(config: DingTalkStreamConfig) {
    this.appKey = config.appKey;
    this.appSecret = config.appSecret;
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.dingtalk.com';
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 订阅入站消息（单订阅者：适配器转发用） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 打开长连接（token 获取 → 网关连接 → register → 事件监听）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    // 1. accessToken
    const accessToken = await this.fetchAccessToken();
    // 2. 网关连接参数（endpoint + ticket）
    const { endpoint, ticket } = await this.fetchConnection(accessToken);
    // 3. WebSocket 连接 + register
    const ws = new WebSocket(endpoint);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError(ErrorCode.IM_CHANNEL_REQUEST_FAILED, '钉钉 Stream 连接超时'));
      }, HTTP_TIMEOUT_MS);
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
        // data 帧：解析并转发入站消息
        if (frame?.type === 'data') {
          this.dispatchFrame(frame);
        }
      });
    });
  }

  /** 关闭长连接（幂等） */
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

  /** accessToken：POST /v1.0/oauth2/accessToken */
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

  /** 网关连接参数：GET /v1.0/gateway/connections/open */
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

  /** POST JSON（超时） */
  private async postJson(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
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

  /** GET（Bearer 鉴权 + 超时） */
  private async getJson(url: string, accessToken: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 心跳：每 30s nop 帧 */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ type: 'nop' }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** data 帧分发：解析 → 转发入站消息 */
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

/** WS 消息 → 帧（JSON 解析容错） */
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
