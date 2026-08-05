// src/main/infra/im/adapters/webhook-channel.ts
// Webhook 渠道适配器基类：群机器人 webhook 发送（钉钉/企业微信/飞书 共用）
// ──────────────────────────────────────────────────────────────
// 设计：
// - token 格式：webhookUrl（钉钉加签时 URL#secret）
// - connect = 配置就绪（webhook 型无握手；真实发送时才验证 URL）
// - sendMessage：构造渠道专属 payload → HTTP POST（超时 + 错误映射 + 重试）
// - 入站：webhook 型群机器人无接收通道（接收需公网回调/长连接，显式标注）
//
// 实现约定（对齐 IChannelAdapter 契约）：
// - 失败分类：URL 缺失 → IM_CHANNEL_NOT_CONFIGURED；格式非法 → IM_CHANNEL_INVALID_TOKEN；
//   网络/非 2xx → IM_CHANNEL_REQUEST_FAILED
// - 发送失败重试 2 次退避（对齐渠道接口注释约定）
// ──────────────────────────────────────────────────────────────

import { AppError, type ChannelKind, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ChannelIncomingMessage, ChannelTarget, IChannelAdapter } from '../channel/types';

/** webhook 发送超时（毫秒） */
const WEBHOOK_TIMEOUT_MS = 10_000;
/** 发送重试次数（对齐渠道接口约定：最多 2 次退避） */
const SEND_RETRY_COUNT = 2;
/** 退避基数（毫秒） */
const RETRY_BASE_MS = 500;

/** webhook 发送结果（渠道错误信息） */
interface WebhookErrorResponse {
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly code?: number;
  readonly msg?: string;
}

/**
 * Webhook 渠道适配器基类
 *
 * 子类职责：实现 kind/displayName/buildPayload（渠道专属消息格式）+ 可选 decorateUrl（加签）。
 */
export abstract class WebhookChannelAdapter implements IChannelAdapter {
  abstract readonly kind: ChannelKind;
  abstract readonly displayName: string;
  abstract readonly implemented: boolean;

  isConnected = false;
  private webhookUrl: string | null = null;
  private secret: string | null = null;

  /**
   * 连接（webhook 型 = 配置就绪；token 为 webhook URL，钉钉加签格式 URL#secret）
   */
  async connect(token: string | undefined): Promise<void> {
    const parsed = parseWebhookToken(token);
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
  }

  /** 断开（webhook 无长连接，仅清状态） */
  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  /** 入站：webhook 群机器人无接收通道（需公网回调，桌面端后置） */
  onMessage(_handler: (message: ChannelIncomingMessage) => void): () => void {
    return () => {};
  }

  /**
   * 回发消息（构造 payload → POST → 重试）
   */
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

  /** 渠道专属 payload（子类实现） */
  protected abstract buildPayload(text: string): unknown;

  /** URL 装饰（加签渠道覆写；钉钉 timestamp+sign） */
  protected async decorateUrl(url: string): Promise<string> {
    return url;
  }

  /** 加签 secret（子类读取用） */
  protected getSecret(): string | null {
    return this.secret;
  }
}

/** token 解析：webhookUrl[#secret] → { url, secret } */
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
  // URL 合法性校验（http/https）
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

/** HTTP POST（超时 + 非 2xx 抛错） */
async function postWebhook(url: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    // 渠道业务错误码检查（钉钉/企业微信/飞书均返回 JSON 状态）
    const text = await response.text();
    if (text.length > 0) {
      try {
        const body = JSON.parse(text) as WebhookErrorResponse;
        const errorCode = body.errcode ?? body.code;
        if (typeof errorCode === 'number' && errorCode !== 0) {
          throw new Error(`渠道错误 ${errorCode}：${body.errmsg ?? body.msg ?? '未知'}`);
        }
      } catch (err: unknown) {
        // 非 JSON 或渠道错误：JSON 解析失败直接抛渠道错误信息
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

/** 简单延迟 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 钉钉加签：timestamp + secret → HMAC-SHA256 → base64 → URL 编码
 *
 * 借鉴声明：算法参考钉钉开放平台机器人安全设置文档（加签流程），
 * 纯逻辑实现无外部依赖。
 */
export async function dingtalkSign(secret: string, timestamp: number): Promise<string> {
  const signString = `${timestamp}\n${secret}`;
  const key = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(signString);
  // Node 20+ 内置 WebCrypto（零依赖）
  return cryptoSign(key, data);
}

/** HMAC-SHA256 → base64（WebCrypto） */
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
