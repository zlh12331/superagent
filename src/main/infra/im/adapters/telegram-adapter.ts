// telegram-adapter.ts：Telegram Bot 渠道——long polling（getUpdates 30s 长轮询）收消息 + Bot API 回发
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import { proxiedFetch } from '../../network/proxied-fetch';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_MS = 30_000;

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat: { readonly id: number; readonly type: string };
    readonly from?: { readonly id: number; readonly username?: string };
    readonly date: number;
  };
}

export class TelegramAdapter implements IChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly displayName = 'Telegram';
  readonly implemented = true;
  readonly configHint: string = 'Bot Token（@BotFather 获取）';

  private readonly fetchFn: typeof fetch;

  constructor(options: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = options.fetchFn ?? (proxiedFetch as unknown as typeof fetch);
  }

  private botToken: string | undefined;
  private pollController: AbortController | undefined;
  private listeners = new Set<(message: ChannelIncomingMessage) => void>();
  private connected = false;

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(token: string | undefined): Promise<void> {
    if (this.connected) {
      return;
    }
    if (token === undefined || token.length === 0) {
      throw new AppError(ErrorCode.IM_CHANNEL_NOT_CONFIGURED, 'Telegram 渠道未配置 token');
    }
    this.botToken = token;

    const me = await this.callApi<{ ok: boolean; result: { username?: string } }>('getMe');
    if (!me.ok) {
      throw new AppError(ErrorCode.IM_CHANNEL_INVALID_TOKEN, 'Telegram token 无效');
    }

    this.connected = true;
    logger.info(
      { username: me.result?.username },
      `Telegram 渠道已连接（@${me.result?.username ?? 'unknown'}）`,
    );

    const pollController = new AbortController();
    this.pollController = pollController;
    void this.pollLoop(pollController).catch((err: unknown) => {
      if (!pollController.signal.aborted) {
        this.connected = false;
        logger.error({ error: err }, 'Telegram 轮询异常退出');
      }
    });
  }

  async disconnect(): Promise<void> {
    this.pollController?.abort();
    this.pollController = undefined;
    this.connected = false;
    this.listeners.clear();
    logger.info({}, 'Telegram 渠道已断开');
  }

  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    if (this.botToken === undefined) {
      throw new AppError(ErrorCode.IM_CHANNEL_NOT_CONFIGURED, 'Telegram 渠道未连接');
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.callApi<{ ok: boolean }>('sendMessage', {
          chat_id: target.chatId,
          text,
        });
        if (res.ok) {
          return;
        }
        lastError = new Error(`Telegram sendMessage 返回失败: ${JSON.stringify(res)}`);
      } catch (err: unknown) {
        lastError = err;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    logger.error({ chatId: target.chatId, error: lastError }, 'Telegram 回发失败（重试耗尽）');
  }

  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private async pollLoop(controller: AbortController): Promise<void> {
    let offset = 0;
    while (!controller.signal.aborted) {
      try {
        const updates = await this.callApi<{
          ok: boolean;
          result: TelegramUpdate[];
        }>('getUpdates', {
          timeout: POLL_TIMEOUT_MS,
          offset,
          allowed_updates: ['message'],
        });
        if (!updates.ok) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        for (const update of updates.result) {
          if (update.update_id >= offset) {
            offset = update.update_id + 1;
          }
          this.dispatchUpdate(update);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          break;
        }
        logger.warn({ error: err }, 'Telegram 轮询请求失败，3s 后重试');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private dispatchUpdate(update: TelegramUpdate): void {
    const message = update.message;
    if (message === undefined || message.text === undefined) {
      return;
    }
    let text = message.text;
    if (message.chat.type === 'group' || message.chat.type === 'supergroup') {
      const stripped = text.replace(/^@[A-Za-z0-9_]{3,64}\s*/, '');
      if (stripped !== text) {
        text = stripped;
      }
    }
    const incoming: ChannelIncomingMessage = {
      channel: this.kind,
      chatId: String(message.chat.id),
      senderId: message.from?.id !== undefined ? String(message.from.id) : undefined,
      text,
      messageId: String(message.message_id),
      timestamp: message.date * 1000,
    };
    for (const listener of this.listeners) {
      try {
        listener(incoming);
      } catch (err: unknown) {
        logger.error({ error: err }, 'Telegram 消息监听器异常');
      }
    }
  }

  private async callApi<T>(
    method: string,
    params: Record<string, string | number | readonly string[]> = {},
  ): Promise<T> {
    if (this.botToken === undefined) {
      throw new AppError(ErrorCode.IM_CHANNEL_NOT_CONFIGURED, 'Telegram 渠道未配置 token');
    }
    const url = `${API_BASE}/bot${this.botToken}/${method}`;
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        body.set(key, JSON.stringify(value));
      } else {
        body.set(key, String(value));
      }
    }
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: this.pollController?.signal ?? null,
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new AppError(
          ErrorCode.IM_CHANNEL_INVALID_TOKEN,
          `Telegram API ${method} 401 token 无效`,
        );
      }
      throw new AppError(
        ErrorCode.IM_CHANNEL_REQUEST_FAILED,
        `Telegram API ${method} HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}
