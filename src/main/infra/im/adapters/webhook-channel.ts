import { AppError, type ChannelKind, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import { proxiedFetch } from '../../network/proxied-fetch';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';

const WEBHOOK_TIMEOUT_MS = 10_000;
const SEND_RETRY_COUNT = 2;
const RETRY_BASE_MS = 500;

interface WebhookErrorResponse {
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly code?: number;
  readonly msg?: string;
}

export abstract class WebhookChannelAdapter implements IChannelAdapter {
  abstract readonly kind: ChannelKind;
  abstract readonly displayName: string;
  abstract readonly implemented: boolean;

  readonly configHint: string = 'webhook URL（发送）；长连接接收见各渠道说明';

  isConnected = false;
  private webhookUrl: string | null = null;
  private secret: string | null = null;

  async connect(token: string | undefined): Promise<void> {
    const parsed = parseWebhookToken(this.parseToken(token ?? ''));
    if (parsed === null) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_INVALID_TOKEN,
        `${this.displayName}：无效的 webhook 地址`,
      );
    }
    this.webhookUrl = parsed.url;
    this.secret = parsed.secret;
    this.isConnected = true;
    logger.info({ kind: this.kind }, `${this.displayName} 渠道配置就绪（webhook）`);
    await this.afterConnect();
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    await this.afterDisconnect();
  }

  onMessage(_handler: (message: ChannelIncomingMessage) => void): () => void {
    return () => {};
  }

  async sendMessage(target: ChannelTarget, text: string): Promise<void> {
    const url = this.webhookUrl;
    if (url === null || !this.isConnected) {
      throw new AppError(
        ErrorCode.IM_CHANNEL_NOT_CONFIGURED,
        `${this.displayName}：渠道未配置 webhook`,
      );
    }
    const payload = this.buildPayload(text);
    const finalUrl = await this.decorateUrl(url);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SEND_RETRY_COUNT; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_MS * attempt);
      }
      try {
        await postWebhook(finalUrl, payload);
        return;
      } catch (err: unknown) {
        lastError = err;
        logger.warn(
          { kind: this.kind, chatId: target.chatId, attempt, error: err },
          `${this.displayName} 回发失败，重试`,
        );
      }
    }
    throw new AppError(
      ErrorCode.IM_CHANNEL_REQUEST_FAILED,
      `${this.displayName}：回发失败（${lastError instanceof Error ? lastError.message : String(lastError)}）`,
    );
  }

  protected abstract buildPayload(text: string): unknown;

  protected async decorateUrl(url: string): Promise<string> {
    return url;
  }

  protected parseToken(token: string): string {
    return token;
  }

  protected async afterConnect(): Promise<void> {}

  protected async afterDisconnect(): Promise<void> {}

  protected getSecret(): string | null {
    return this.secret;
  }
}

function parseWebhookToken(
  token: string | undefined,
): { url: string; secret: string | null } | null {
  if (token === undefined || token.trim().length === 0) {
    return null;
  }
  const trimmed = token.trim();
  let url = trimmed;
  let secret: string | null = null;
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex !== -1) {
    url = trimmed.slice(0, hashIndex);
    const rest = trimmed.slice(hashIndex + 1);
    secret = rest.length > 0 ? rest : null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }
  return { url, secret };
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await (proxiedFetch as unknown as typeof fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (text.length > 0) {
      try {
        const body = JSON.parse(text) as WebhookErrorResponse;
        const errorCode = body.errcode ?? body.code;
        if (typeof errorCode === 'number' && errorCode !== 0) {
          throw new Error(`渠道错误 ${errorCode}：${body.errmsg ?? body.msg ?? '未知'}`);
        }
      } catch (err: unknown) {
        if (err instanceof AppError) {
          throw err;
        }
        throw new Error(`响应解析失败：${String(err)}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dingtalkSign(secret: string, timestamp: number): Promise<string> {
  const signString = `${timestamp}\n${secret}`;
  const key = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(signString);
  return cryptoSign(key, data);
}

async function cryptoSign(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    Buffer.from(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, Buffer.from(data));
  return Buffer.from(signature).toString('base64');
}
