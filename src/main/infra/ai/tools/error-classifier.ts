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
    return failure({
      code: ModelErrorCode.ModelRequestCancelled,
      reason: ModelFailureReason.Cancelled,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      message: '请求已取消',
    });
  }

  if (error instanceof LoadAPIKeyError) {
    return failure({
      code: ModelErrorCode.ModelAuthFailed,
      reason: ModelFailureReason.Runtime,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      message: 'API Key 未配置',
    });
  }

  if (error instanceof APICallError) {
    return classifyApiCallFailure(error);
  }

  if (error instanceof TypeError) {
    return classifyNetworkTypeError(error);
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return failure({
      code: ModelErrorCode.ModelRequestTimeout,
      reason: ModelFailureReason.NetworkError,
      retryReason: ModelRetryReason.Timeout,
      retryable: true,
      message: '请求超时',
    });
  }

  // 兜底：非 Error 值或未识别 Error——按不可重试处理（编程错误伪装成网络抖动比少试一次更糟）
  const message = error instanceof Error ? error.message : String(error);
  return failure({
    code: ModelErrorCode.ModelUnknown,
    reason: ModelFailureReason.Runtime,
    retryReason: ModelRetryReason.NotRetryable,
    retryable: false,
    message,
  });
}

/**
 * 纯状态码 → 三轴查表（无需消息形态判断的固定映射；context 超限/5xx/SDK 标记
 * 因带额外逻辑不在此表，见 classifyApiCallFailure 的优先级链）。
 */
const STATUS_AXES: ReadonlyMap<
  number,
  Omit<ModelFailure, 'message' | 'statusCode' | 'retryAfterMs'>
> = new Map([
  [
    401,
    {
      code: ModelErrorCode.ModelAuthFailed,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    403,
    {
      code: ModelErrorCode.ModelAuthFailed,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    402,
    {
      code: ModelErrorCode.ModelBalanceInsufficient,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    404,
    {
      code: ModelErrorCode.ModelNotFound,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    408,
    {
      code: ModelErrorCode.ModelRequestTimeout,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.Timeout,
      retryable: true,
    },
  ],
  [
    413,
    {
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    429,
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.RateLimited,
      retryable: true,
    },
  ],
  [
    422,
    {
      code: ModelErrorCode.ModelInvalidRequest,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
  [
    400,
    {
      code: ModelErrorCode.ModelInvalidRequest,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
    },
  ],
]);

function classifyApiCallFailure(error: APICallError): ModelFailure {
  const { statusCode, isRetryable } = error;
  const errorText = extractErrorText(error);
  const retryAfterMs = parseRetryAfterSeconds(error);
  const withStatus = <T extends object>(axes: T): T & { readonly statusCode: number } => ({
    ...axes,
    statusCode: statusCode as number,
  });
  // Retry-After 透传为条件字段（exactOptionalPropertyTypes 下不能显式 undefined）
  const retryAfterField = (): { readonly retryAfterMs: number } | Record<string, never> =>
    retryAfterMs !== undefined ? { retryAfterMs } : {};

  // ── context 超限：文案形态优先（多数 provider 用 400 + 文案；裸 413 落查表）──
  if (CONTEXT_EXCEEDED_MESSAGE_PATTERN.test(errorText)) {
    return failure({
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      message: '上下文超出模型窗口，请精简对话或新建会话',
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
  }

  // ── 限流（唯一携带 retryAfterMs 的常规路径，先于查表）──
  if (statusCode === 429) {
    return failure({
      ...withStatus(
        STATUS_AXES.get(429) as Omit<ModelFailure, 'message' | 'statusCode' | 'retryAfterMs'>,
      ),
      message: '请求过于频繁',
      ...retryAfterField(),
    });
  }

  // ── 状态码查表 ──
  const fromTable = statusCode !== undefined ? STATUS_AXES.get(statusCode) : undefined;
  if (fromTable !== undefined) {
    return failure({
      ...withStatus(fromTable),
      message: STATUS_MESSAGES[fromTable.code] ?? error.message,
    });
  }

  // ── 服务端错：5xx（带 Retry-After 透传）──
  if (statusCode !== undefined && statusCode >= 500) {
    return failure({
      code: ModelErrorCode.ModelServerError,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.ServerError,
      retryable: true,
      message: '模型服务异常',
      statusCode,
      ...retryAfterField(),
    });
  }

  // ── SDK 可重试标记（无状态码的连接类失败）──
  if (isRetryable) {
    return failure({
      code: ModelErrorCode.ModelNetworkError,
      reason: ModelFailureReason.NetworkError,
      retryReason: ModelRetryReason.NetworkError,
      retryable: true,
      message: '网络连接中断',
      ...retryAfterField(),
    });
  }

  // ── 其余带状态码的未匹配形态（418 等零散码）：归参数错，不落 Unknown ──
  if (statusCode !== undefined) {
    return failure({
      code: ModelErrorCode.ModelInvalidRequest,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      message: error.message,
      statusCode,
    });
  }

  return failure({
    code: ModelErrorCode.ModelUnknown,
    reason: ModelFailureReason.Provider,
    retryReason: ModelRetryReason.NotRetryable,
    retryable: false,
    message: error.message,
  });
}

/** 查表码的固定用户可读消息（与旧 if 链文案逐字一致） */
const STATUS_MESSAGES: Readonly<Partial<Record<ModelErrorCode, string>>> = {
  [ModelErrorCode.ModelAuthFailed]: 'API Key 无效或已过期',
  [ModelErrorCode.ModelBalanceInsufficient]: '账户余额不足',
  [ModelErrorCode.ModelNotFound]: '模型不存在',
  [ModelErrorCode.ModelRequestTimeout]: '请求超时',
  [ModelErrorCode.ModelContextExceeded]: '上下文过长',
  [ModelErrorCode.ModelRateLimited]: '请求过于频繁',
  [ModelErrorCode.ModelInvalidRequest]: '请求参数错误',
};

/** TypeError 网络形态：cause 链错误码裁决（ECONNRESET 可重试 / EACCES 不可），无码回退 message 形态 */
function classifyNetworkTypeError(error: TypeError): ModelFailure {
  const causeCode = findErrorCode(error.cause);
  const networked = causeCode !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(causeCode);
  const messageShape = /fetch failed|network error|load failed|terminated/i.test(error.message);

  if (causeCode !== undefined && !networked) {
    // 真实根因明确不可重试（EACCES 等系统错）
    return failure({
      code: ModelErrorCode.ModelUnknown,
      reason: ModelFailureReason.Runtime,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      message: error.message,
    });
  }

  if (networked || messageShape) {
    return failure({
      code: ModelErrorCode.ModelNetworkError,
      reason: ModelFailureReason.NetworkError,
      retryReason: ModelRetryReason.NetworkError,
      retryable: true,
      message: '网络连接中断',
    });
  }

  // 编程错误形态的 TypeError：不伪装成网络抖动
  return failure({
    code: ModelErrorCode.ModelUnknown,
    reason: ModelFailureReason.Runtime,
    retryReason: ModelRetryReason.NotRetryable,
    retryable: false,
    message: error.message,
  });
}

function failure(axes: {
  readonly code: ModelErrorCode;
  readonly reason: ModelFailureReason;
  readonly retryReason: ModelRetryReason;
  readonly retryable: boolean;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
}): ModelFailure {
  return {
    code: axes.code,
    reason: axes.reason,
    retryReason: axes.retryReason,
    retryable: axes.retryable,
    message: axes.message,
    ...(axes.statusCode !== undefined ? { statusCode: axes.statusCode } : {}),
    ...(axes.retryAfterMs !== undefined ? { retryAfterMs: axes.retryAfterMs } : {}),
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
