// src/main/infra/im/adapters/weixin-stream.ts
// 微信渠道：iLink 智能机器人 API（长轮询接收 + 消息发送）
// ──────────────────────────────────────────────────────────────
// 协议（腾讯 iLink Bot API，参考 qwen weixin 包收敛）：
// 1. 接收：POST {baseUrl}/ilink/bot/getupdates { get_updates_buf(游标), base_info } 长轮询
//    —— 游标续传 + 40s 超时（AbortError 继续）+ errcode -14 会话过期暂停
// 2. 发送：POST {baseUrl}/ilink/bot/sendmsg { to_user_id, client_id, context_token, item_list }
// 3. 消息形状：message_id / from_user_id / session_id / item_list（text_item.text / voice_item.text）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/channels/weixin/src/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// api.ts（getUpdates/sendmsg 协议）+ monitor.ts（长轮询游标循环）语义，
// 按我们的技术栈收敛重写：
// - 移除账号文件持久化（凭据走 keychain）/媒体下载（保留扩展位）
// - 保留核心：getupdates 游标长轮询 + 消息归一化
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

/** iLink 默认网关 */
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 协议版本（qwen 兼容值） */
const ILINK_PROTOCOL_VERSION = '2.1.3';
/** 长轮询超时（毫秒） */
const POLL_TIMEOUT_MS = 40_000;
/** 会话过期暂停（毫秒） */
const SESSION_EXPIRED_PAUSE_MS = 30_000;
/** 连续错误退避基数（毫秒） */
const ERROR_BACKOFF_MS = 5_000;

/** iLink 消息形状 */
export interface WeixinMessage {
  readonly seq?: number;
  readonly message_id?: number;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly session_id?: string;
  readonly create_time_ms?: number;
  readonly context_token?: string;
  readonly item_list?: Array<{
    readonly type?: number;
    readonly text_item?: { readonly text?: string };
    readonly voice_item?: { readonly text?: string };
  }>;
}

/** getupdates 响应 */
export interface WeixinUpdatesResponse {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly WeixinMessage[];
  readonly get_updates_buf?: string;
}

/** 解析结果：null = 无文本（忽略） */
export interface ParsedWeixinMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly timestamp: number;
  readonly contextToken: string | undefined;
}

/** 文本项类型（iLink 协议） */
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_VOICE = 3;

/**
 * iLink 消息解析（纯函数，可测）
 */
export function parseWeixinMessage(msg: WeixinMessage): ParsedWeixinMessage | null {
  const text = extractWeixinText(msg);
  if (text.length === 0) {
    return null;
  }
  const senderId = msg.from_user_id ?? '';
  const chatId = senderId;
  if (chatId.length === 0) {
    return null;
  }
  return {
    text,
    chatId,
    senderId,
    messageId: msg.message_id !== undefined ? String(msg.message_id) : `${chatId}:${Date.now()}`,
    timestamp: msg.create_time_ms ?? Date.now(),
    contextToken: msg.context_token,
  };
}

/** 文本提取：text_item → voice_item（转文字） */
function extractWeixinText(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT) {
      const text = item.text_item?.text;
      if (text !== undefined && text.length > 0) {
        parts.push(text);
      }
    } else if (item.type === ITEM_TYPE_VOICE) {
      const text = item.voice_item?.text;
      if (text !== undefined && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join('').trim();
}

/** 轮询接收配置 */
export interface WeixinStreamConfig {
  /** iLink 机器人 token */
  readonly token: string;
  /** 网关基地址（测试注入；缺省 iLink 官方） */
  readonly baseUrl?: string;
}

/**
 * 微信长轮询接收器（生命周期 open/close）
 */
export class WeixinStreamReceiver {
  private readonly token: string;
  private readonly baseUrl: string;
  private cursor = '';
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private abortController: AbortController | null = null;
  /** from_user_id → context_token（回发携带） */
  private readonly contextTokens = new Map<string, string>();
  private opened = false;

  constructor(config: WeixinStreamConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? WEIXIN_DEFAULT_BASE_URL;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 订阅入站消息（单订阅者：适配器转发用） */
  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 打开长轮询（直到 close；getupdates 游标续传）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    this.opened = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    logger.info({}, '微信 iLink 轮询已启动（接收就绪）');
    // 轮询循环不阻塞 open（后台运行）
    void this.pollLoop(signal);
  }

  /** 获取会话 context_token（sendmsg 回发携带） */
  getContextToken(chatId: string): string | undefined {
    return this.contextTokens.get(chatId);
  }

  /** 关闭轮询（幂等） */
  close(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.opened = false;
  }

  /** 长轮询主循环（游标续传 + 超时继续 + 错误退避） */
  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      try {
        const response = await fetchWeixinUpdates(
          this.baseUrl,
          this.token,
          this.cursor,
          POLL_TIMEOUT_MS,
          signal,
        );
        if (response.errcode === -14) {
          // 会话过期：暂停后继续（token 需重新配置）
          logger.warn({}, '微信 iLink 会话过期，暂停 30s');
          await sleep(SESSION_EXPIRED_PAUSE_MS, signal);
          continue;
        }
        consecutiveErrors = 0;
        if (response.get_updates_buf !== undefined) {
          this.cursor = response.get_updates_buf;
        }
        for (const msg of response.msgs ?? []) {
          this.dispatchMessage(msg);
        }
      } catch (err: unknown) {
        if (signal.aborted) {
          return;
        }
        consecutiveErrors += 1;
        logger.warn({ error: err, attempt: consecutiveErrors }, '微信轮询失败');
        await sleep(Math.min(ERROR_BACKOFF_MS * consecutiveErrors, 30_000), signal);
      }
    }
  }

  /** 消息分发：解析 → 转发入站消息 */
  private dispatchMessage(msg: WeixinMessage): void {
    const parsed = parseWeixinMessage(msg);
    if (parsed === null) {
      return;
    }
    this.messageHandler?.({
      channel: 'wechat',
      chatId: parsed.chatId,
      senderId: parsed.senderId,
      text: parsed.text,
      messageId: parsed.messageId,
      timestamp: parsed.timestamp,
    });
  }
}

/**
 * getupdates 请求（端点可注入测试）
 */
export async function fetchWeixinUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WeixinUpdatesResponse> {
  try {
    return await postJson<WeixinUpdatesResponse>(
      `${baseUrl}/ilink/bot/getupdates`,
      token,
      {
        ...(cursor.length > 0 ? { get_updates_buf: cursor } : {}),
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
      timeoutMs,
      signal,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // 轮询超时（长轮询正常返回）：视为空结果继续
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    }
    throw err;
  }
}

/**
 * 发送文本消息（端点可注入测试）
 */
export async function sendWeixinText(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  const response = await postJson<{ ret?: number; errmsg?: string }>(
    `${baseUrl}/ilink/bot/sendmsg`,
    token,
    {
      to_user_id: toUserId,
      from_user_id: '',
      client_id: randomUUID(),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      ...(contextToken !== undefined ? { context_token: contextToken } : {}),
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: text.slice(0, 2000) } }],
    },
    15_000,
    new AbortController().signal,
  );
  if (response.ret !== undefined && response.ret !== 0) {
    throw new AppError(
      ErrorCode.IM_CHANNEL_REQUEST_FAILED,
      `微信发送失败（ret ${response.ret}）：${response.errmsg ?? '未知'}`,
    );
  }
}

/** POST JSON（iLink 鉴权头） */
async function postJson<T>(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  // 父信号联动
  const parentListener = (): void => controller.abort();
  signal.addEventListener('abort', parentListener);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'iLink-App-ClientVersion': '0x020103',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', parentListener);
  }
}

/** 可中断延迟 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
