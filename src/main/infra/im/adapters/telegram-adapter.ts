// src/main/infra/im/adapters/telegram-adapter.ts
// Telegram 渠道适配器（Bot API 长轮询，原生 fetch 零依赖）
// ──────────────────────────────────────────────────────────────
// 协议：
// - getMe 验证 token → 失败抛 AppError（AI_API_KEY_INVALID 语义的 IM 变体）
// - getUpdates 长轮询（timeout=30s，offset 递增防重复）
// - sendMessage 回发（失败重试 2 次退避）
//
// 设计：
// - 轮询循环用 AbortController 控制（disconnect 时中止）
// - 消息去重：Telegram offset 语义天然去重（确认后才推进 offset）
// - 群聊消息剥离 @BotName 前缀（防止 bot 回复自己触发循环）
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_MS = 30_000;

/** Telegram 消息原始形状（长轮询响应子集） */
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

/**
 * Telegram Bot 渠道适配器
 */
export class TelegramAdapter implements IChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly displayName = 'Telegram';
  readonly implemented = true;
  readonly configHint: string = 'Bot Token（@BotFather 获取）';

  /**
   * HTTP 依赖注入点（测试传 fake fetch，生产默认全局 fetch）
   * 注入而非 mock：网络外部依赖可替换，业务逻辑保持真实实现
   */
  private readonly fetchFn: typeof fetch;

  constructor(options: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
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

    // 验证 token（getMe）
    const me = await this.callApi<{ ok: boolean; result: { username?: string } }>('getMe');
    if (!me.ok) {
      throw new AppError(ErrorCode.IM_CHANNEL_INVALID_TOKEN, 'Telegram token 无效');
    }

    this.connected = true;
    logger.info(
      { username: me.result?.username },
      `Telegram 渠道已连接（@${me.result?.username ?? 'unknown'}）`,
    );

    // 启动长轮询（后台协程）
    const pollController = new AbortController();
    this.pollController = pollController;
    void this.pollLoop(pollController).catch((err: unknown) => {
      // 轮询异常（网络中断等）：标记断开，不崩溃
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
    // 失败重试 2 次（指数退避：500ms / 1000ms）
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

  /**
   * 长轮询循环：getUpdates（timeout=30s）→ 逐条确认 → offset 推进
   */
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
        // 网络抖动：退避后继续（不终止轮询）
        logger.warn({ error: err }, 'Telegram 轮询请求失败，3s 后重试');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  /**
   * 单条 update → 领域消息分发（过滤非文本 / 群聊 @bot 前缀剥离）
   */
  private dispatchUpdate(update: TelegramUpdate): void {
    const message = update.message;
    if (message === undefined || message.text === undefined) {
      return; // 非文本消息（图片/命令等）忽略
    }
    let text = message.text;
    // 群聊中 bot 名称为前缀时剥离（避免 bot 回复自身消息形成循环）
    // 匹配形如 `@MyBot 用户内容` / `@MyBot\n用户内容`
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
        // 监听器异常隔离：不中断其他监听器
        logger.error({ error: err }, 'Telegram 消息监听器异常');
      }
    }
  }

  /**
   * Bot API 调用（fetch + 表单编码，兼容 Node/Electron）
   */
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
      // fetch 的 signal 接受 null：undefined 显式转 null
      signal: this.pollController?.signal ?? null,
    });
    if (!response.ok) {
      // HTTP 401 = token 无效（Telegram Bot API 语义），任何方法的 401 都表示凭证问题
      // （真实缺陷修复：原实现统一抛 REQUEST_FAILED，导致 getMe 校验时 token 无效
      //  被错误分类，无法给出 INVALID_TOKEN 引导用户重新配置）
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
