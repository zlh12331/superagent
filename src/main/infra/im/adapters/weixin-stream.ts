import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage } from '../channel/types';

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_PROTOCOL_VERSION = '2.1.3';
const POLL_TIMEOUT_MS = 40_000;
const SESSION_EXPIRED_PAUSE_MS = 30_000;
const ERROR_BACKOFF_MS = 5_000;

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

export interface WeixinUpdatesResponse {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly WeixinMessage[];
  readonly get_updates_buf?: string;
}

export interface ParsedWeixinMessage {
  readonly text: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly timestamp: number;
  readonly contextToken: string | undefined;
}

const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_VOICE = 3;

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

export interface WeixinStreamConfig {
  readonly token: string;
  readonly baseUrl?: string;
}

export class WeixinStreamReceiver {
  private readonly token: string;
  private readonly baseUrl: string;

  private readonly fetchUpdatesFn: typeof fetchWeixinUpdates;
  private readonly backoffMs: number;
  private readonly sessionPauseMs: number;

  private cursor = '';
  private messageHandler: ((message: ChannelIncomingMessage) => void) | null = null;
  private abortController: AbortController | null = null;
  private readonly contextTokens = new Map<string, string>();
  private opened = false;

  constructor(
    config: WeixinStreamConfig,
    options: {
      fetchUpdatesFn?: typeof fetchWeixinUpdates;
      backoffMs?: number;
      sessionPauseMs?: number;
    } = {},
  ) {
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? WEIXIN_DEFAULT_BASE_URL;
    this.fetchUpdatesFn = options.fetchUpdatesFn ?? fetchWeixinUpdates;
    this.backoffMs = options.backoffMs ?? ERROR_BACKOFF_MS;
    this.sessionPauseMs = options.sessionPauseMs ?? SESSION_EXPIRED_PAUSE_MS;
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
    this.opened = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    logger.info({}, '微信 iLink 轮询已启动（接收就绪）');
    void this.pollLoop(signal);
  }

  getContextToken(chatId: string): string | undefined {
    return this.contextTokens.get(chatId);
  }

  close(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.opened = false;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      try {
        const response = await this.fetchUpdatesFn({
          baseUrl: this.baseUrl,
          token: this.token,
          cursor: this.cursor,
          timeoutMs: POLL_TIMEOUT_MS,
          signal,
        });
        if (response.errcode === -14) {
          logger.warn({}, '微信 iLink 会话过期，暂停 30s');
          await sleep(this.sessionPauseMs, signal);
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
        await sleep(Math.min(this.backoffMs * consecutiveErrors, 30_000), signal);
      }
    }
  }

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

export async function fetchWeixinUpdates(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly cursor: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<WeixinUpdatesResponse> {
  const { baseUrl, token, cursor, timeoutMs, signal } = options;
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
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    }
    throw err;
  }
}

export async function sendWeixinText(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly toUserId: string;
  readonly text: string;
  readonly contextToken: string | undefined;
}): Promise<void> {
  const { baseUrl, token, toUserId, text, contextToken } = options;
  const response = await postJson<{ ret?: number; errmsg?: string }>(
    `${baseUrl}/ilink/bot/sendmsg`,
    token,
    {
      to_user_id: toUserId,
      from_user_id: '',
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
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

async function postJson<T>(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
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
