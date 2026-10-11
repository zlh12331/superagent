// error-classifier.ts：模型失败分类器——裸错误 → ModelFailure（三轴结构化，全系统唯一翻译点）
// AppError 路径（classifyError）保留为兼容包装：内部走三轴分类后映射回 ErrorCode.AI_* 码族
import {
  AppError,
  ErrorCode,
  ModelErrorCode,
  type ModelFailure,
  ModelFailureReason,
  ModelRetryReason,
} from '@code-agent/shared/main';
import { APICallError, LoadAPIKeyError } from 'ai';
import { RETRYABLE_NETWORK_ERROR_CODES } from '../llm-client/retry';

/** 是否中止类错误（AbortError 名——回合取消/超时统一判据） */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  return false;
}

/**
 * 供应商 context 超限的错误文案形态（各家措辞归一）：
 * OpenAI/DeepSeek `context_length_exceeded` / `maximum context length`，
 * Anthropic `prompt is too long`，另有 `too many input tokens` 变体。
 * 刻意不含孤词 `context window`——部分 provider 的定价/参数说明错误也带这个词，太宽会误判。
 */
const CONTEXT_EXCEEDED_MESSAGE_PATTERN =
  /context[_ ]length[_ ]exceeded|prompt is too long|maximum context length|too many (input )?tokens|input length exceeds/i;

/** 从 APICallError 提取可供文案匹配的文本（message + responseBody） */
function extractErrorText(error: APICallError): string {
  const body =
    typeof error.responseBody === 'string'
      ? error.responseBody
      : error.responseBody !== undefined
        ? JSON.stringify(error.responseBody)
        : '';
  return `${error.message}\n${body}`;
}

/** 沿 cause 链找第一个字符串 code（限深防环；undici 真实网络码在 TypeError.cause 里） */
function findErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

/** 解析 Retry-After 头（秒数形态；毫秒/日期形态由重试执行器负责——这里只做重试决策所需的粗值） */
function parseRetryAfterSeconds(error: APICallError): number | undefined {
  const headers = error.responseHeaders;
  if (headers === undefined) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'retry-after' && typeof value === 'string') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return undefined;
}

/**
 * 模型失败三轴分类——全系统唯一的错误翻译点。
 *
 * 优先级链（先判定的形态优先）：取消 → context 超限（文案形态优先于状态码）→ 空值防御 →
 * 认证/余额/不存在/限流/超时（状态码）→ 参数错 → TLS/代理/网络（cause 链裁决）→ 5xx → SDK 可重试标记 → 兜底。
 */
export function classifyModelFailure(error: unknown): ModelFailure {
  // ── 取消：对照 AbortError 名，非供应商失败 ──
  if (isAbortError(error)) {
    return failure(
      ModelErrorCode.ModelRequestCancelled,
      ModelFailureReason.Cancelled,
      ModelRetryReason.NotRetryable,
      false,
      '请求已取消',
    );
  }

  if (error instanceof LoadAPIKeyError) {
    return failure(
      ModelErrorCode.ModelAuthFailed,
      ModelFailureReason.Runtime,
      ModelRetryReason.NotRetryable,
      false,
      'API Key 未配置',
    );
  }

  if (error instanceof APICallError) {
    return classifyApiCallFailure(error);
  }

  if (error instanceof TypeError) {
    return classifyNetworkTypeError(error);
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return failure(
      ModelErrorCode.ModelRequestTimeout,
      ModelFailureReason.NetworkError,
      ModelRetryReason.Timeout,
      true,
      '请求超时',
    );
  }

  // 兜底：非 Error 值或未识别 Error——按不可重试处理（编程错误伪装成网络抖动比少试一次更糟）
  const message = error instanceof Error ? error.message : String(error);
  return failure(
    ModelErrorCode.ModelUnknown,
    ModelFailureReason.Runtime,
    ModelRetryReason.NotRetryable,
    false,
    message,
  );
}

function classifyApiCallFailure(error: APICallError): ModelFailure {
  const { statusCode, isRetryable } = error;
  const errorText = extractErrorText(error);
  const retryAfterMs = parseRetryAfterSeconds(error);

  // ── context 超限：文案形态优先（多数 provider 用 400 + 文案；413 少数派且同样命中）──
  if (
    CONTEXT_EXCEEDED_MESSAGE_PATTERN.test(errorText) ||
    (statusCode === 413 && errorText.trim().length === 0)
  ) {
    return failure(
      ModelErrorCode.ModelContextExceeded,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      '上下文超出模型窗口，请精简对话或新建会话',
      ...(statusCode !== undefined ? [{ statusCode }] : []),
    );
  }

  // ── 认证：401/403（不可重试——重试前需用户换 Key）──
  if (statusCode === 401 || statusCode === 403) {
    return failure(
      ModelErrorCode.ModelAuthFailed,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      'API Key 无效或已过期',
      { statusCode },
    );
  }

  // ── 余额：402 ──
  if (statusCode === 402) {
    return failure(
      ModelErrorCode.ModelBalanceInsufficient,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      '账户余额不足',
      { statusCode },
    );
  }

  // ── 不存在：404 ──
  if (statusCode === 404) {
    return failure(
      ModelErrorCode.ModelNotFound,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      '模型不存在',
      { statusCode },
    );
  }

  // ── 超时：408 ──
  if (statusCode === 408) {
    return failure(
      ModelErrorCode.ModelRequestTimeout,
      ModelFailureReason.Provider,
      ModelRetryReason.Timeout,
      true,
      '请求超时',
      { statusCode },
    );
  }

  // ── 裸 413（无超限文案）：仍按 context 超限归类 ──
  if (statusCode === 413) {
    return failure(
      ModelErrorCode.ModelContextExceeded,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      '上下文过长',
      { statusCode },
    );
  }

  // ── 限流：429（唯一携带 retryAfterMs 的常规路径）──
  if (statusCode === 429) {
    return failure(
      ModelErrorCode.ModelRateLimited,
      ModelFailureReason.Provider,
      ModelRetryReason.RateLimited,
      true,
      '请求过于频繁',
      { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), statusCode },
    );
  }

  // ── 参数错：422（400 无超限文案也归此类）──
  if (statusCode === 422 || statusCode === 400) {
    return failure(
      ModelErrorCode.ModelInvalidRequest,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      '请求参数错误',
      { statusCode },
    );
  }

  // ── 服务端错：5xx ──
  if (statusCode !== undefined && statusCode >= 500) {
    return failure(
      ModelErrorCode.ModelServerError,
      ModelFailureReason.Provider,
      ModelRetryReason.ServerError,
      true,
      '模型服务异常',
      {
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
      },
    );
  }

  // ── SDK 可重试标记（无状态码的连接类失败）──
  if (isRetryable) {
    return failure(
      ModelErrorCode.ModelNetworkError,
      ModelFailureReason.NetworkError,
      ModelRetryReason.NetworkError,
      true,
      '网络连接中断',
      { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  // ── 其余带状态码的未匹配形态（418 等 4xx 零散码）：归参数错，不落 Unknown ──
  if (statusCode !== undefined) {
    return failure(
      ModelErrorCode.ModelInvalidRequest,
      ModelFailureReason.Provider,
      ModelRetryReason.NotRetryable,
      false,
      error.message,
      { statusCode },
    );
  }

  return failure(
    ModelErrorCode.ModelUnknown,
    ModelFailureReason.Provider,
    ModelRetryReason.NotRetryable,
    false,
    error.message,
  );
}

/** TypeError 网络形态：cause 链错误码裁决（ECONNRESET 可重试 / EACCES 不可），无码回退 message 形态 */
function classifyNetworkTypeError(error: TypeError): ModelFailure {
  const causeCode = findErrorCode(error.cause);
  const networked = causeCode !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(causeCode);
  const messageShape = /fetch failed|network error|load failed|terminated/i.test(error.message);

  if (causeCode !== undefined && !networked) {
    // 真实根因明确不可重试（EACCES 等系统错）
    return failure(
      ModelErrorCode.ModelUnknown,
      ModelFailureReason.Runtime,
      ModelRetryReason.NotRetryable,
      false,
      error.message,
    );
  }

  if (networked || messageShape) {
    return failure(
      ModelErrorCode.ModelNetworkError,
      ModelFailureReason.NetworkError,
      ModelRetryReason.NetworkError,
      true,
      '网络连接中断',
    );
  }

  // 编程错误形态的 TypeError：不伪装成网络抖动
  return failure(
    ModelErrorCode.ModelUnknown,
    ModelFailureReason.Runtime,
    ModelRetryReason.NotRetryable,
    false,
    error.message,
  );
}

function failure(
  code: ModelErrorCode,
  reason: ModelFailureReason,
  retryReason: ModelRetryReason,
  retryable: boolean,
  message: string,
  extra?: { readonly statusCode?: number; readonly retryAfterMs?: number },
): ModelFailure {
  return {
    code,
    reason,
    retryReason,
    retryable,
    message,
    ...(extra?.statusCode !== undefined ? { statusCode: extra.statusCode } : {}),
    ...(extra?.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// 兼容包装：AppError 路径（既有消费方签名不变）
// ─────────────────────────────────────────────────────────────

/** 三轴 code → ErrorCode.AI_* 映射（渲染层 i18n / TurnErrorNotice 消费面不变） */
const CODE_TO_LEGACY: Readonly<Record<ModelErrorCode, ErrorCode>> = {
  [ModelErrorCode.ModelRequestCancelled]: ErrorCode.AI_STREAM_INTERRUPTED,
  [ModelErrorCode.ModelContextExceeded]: ErrorCode.AI_CONTEXT_TOO_LARGE,
  [ModelErrorCode.ModelRateLimited]: ErrorCode.AI_RATE_LIMITED,
  [ModelErrorCode.ModelRequestTimeout]: ErrorCode.AI_TIMEOUT,
  [ModelErrorCode.ModelStreamIdleTimeout]: ErrorCode.AI_TIMEOUT,
  [ModelErrorCode.ModelServerError]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelNetworkError]: ErrorCode.AI_STREAM_INTERRUPTED,
  [ModelErrorCode.ModelTlsError]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelProxyError]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelAuthFailed]: ErrorCode.AI_API_KEY_INVALID,
  [ModelErrorCode.ModelBalanceInsufficient]: ErrorCode.AI_BALANCE_INSUFFICIENT,
  [ModelErrorCode.ModelNotFound]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelInvalidRequest]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelInvalidResponse]: ErrorCode.AI_MODEL_ERROR,
  [ModelErrorCode.ModelEmptyResponse]: ErrorCode.AI_EMPTY_RESPONSE,
  [ModelErrorCode.ModelUnknown]: ErrorCode.INTERNAL_ERROR,
};

/**
 * 裸错误 → AppError（AI_* 码族）——既有消费方（agent-service 回合收尾等）签名不变。
 * 内部走 classifyModelFailure 三轴分类，保证两条路径的判定永远一致。
 */
export function classifyError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const failureResult = classifyModelFailure(error);
  // LoadAPIKeyError 语义是「Key 未配置」而非「Key 无效」——三轴归同为 auth，
  // 兼容层按原始错误类型细分 legacy 码（消费面 i18n 文案不同：MISSING=请先配置）
  const legacyCode =
    error instanceof LoadAPIKeyError
      ? ErrorCode.AI_API_KEY_MISSING
      : CODE_TO_LEGACY[failureResult.code];
  return new AppError(
    legacyCode,
    failureResult.message,
    error instanceof Error ? error : undefined,
  );
}
