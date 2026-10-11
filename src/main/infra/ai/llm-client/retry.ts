// retry.ts：LLM 调用重试——可重试判据（429/5xx/网络错误码）+ 指数退避执行器 + 错误码/状态码提取
// 退避参数支持环境变量覆盖（CODE_AGENT_MODEL_RETRY_*），归一化收口在 resolveRetryOptions
import { APICallError } from 'ai';

// 网络层可重试错误码（undici 系列 + 经典 socket 错误）
export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof APICallError) {
    return error.statusCode;
  }
  return undefined;
}

/** 可重试判定：429/5xx/SDK 标记可重试/网络错误码/TypeError（fetch 失联形态） */
export function isRetryableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }
  if (error instanceof APICallError) {
    return error.isRetryable === true;
  }
  const code = getErrorCode(error);
  if (code !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

/**
 * Retry-After 延迟的来源诊断（取值路径审计用——该值可能在 header 保留、解析、采纳任一层断链）。
 *
 * - `provider_header`：供应商头被解析且已采纳
 * - `blocked_by_x_should_retry`：x-should-retry: false 显式否决
 * - `header_unparsed_or_ignored`：头存在但解析失败/超出采纳窗口被拒
 * - `missing`：响应无任何 Retry-After 相关头
 */
export type RetryAfterSource =
  | 'provider_header'
  | 'blocked_by_x_should_retry'
  | 'header_unparsed_or_ignored'
  | 'missing';

/** 大小写不敏感读响应头（供应商头键大小写不定） */
function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function isShouldRetryHeaderBlocked(headers: Record<string, unknown>): boolean {
  const value = readHeader(headers, 'x-should-retry')?.trim().toLowerCase();
  return value === 'false' || value === '0';
}

/**
 * 解析 Retry-After 头为毫秒（支持 `retry-after`（秒/HTTP 日期）与 `retry-after-ms`（毫秒）两种形态；
 * HTTP 日期形态解析失败返回 undefined——不猜未来时间。
 */
export function getRetryAfterDelayMs(error: unknown): number | undefined {
  if (!(error instanceof APICallError)) {
    return undefined;
  }
  const headers = error.responseHeaders;
  if (headers === undefined) {
    return undefined;
  }
  const msValue = readHeader(headers, 'retry-after-ms');
  if (msValue !== undefined) {
    const ms = Number(msValue);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.floor(ms);
    }
  }
  const secondsValue = readHeader(headers, 'retry-after');
  if (secondsValue === undefined) {
    return undefined;
  }
  const seconds = Number(secondsValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(secondsValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) {
      return delta;
    }
  }
  return undefined;
}

export interface RetryAttemptInfo {
  readonly attempt: number;
  readonly error: unknown;
  readonly errorStatus: number | undefined;
  readonly delayMs: number;
  /** 本轮延迟是否被抖动缩短（equal jitter：×[0.5, 1.0)）；诊断重试时序用 */
  readonly jittered: boolean;
  /** 本轮等待值的来源诊断（Retry-After 断链审计：头保留/解析/采纳任一层都可能断） */
  readonly retryAfterSource: RetryAfterSource;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** equal jitter（50%~100% 区间均匀抖动）：默认开——多调用并发被 429 打回时不步调一致重冲供应商 */
  readonly jitter?: boolean;
  readonly shouldRetryOnError?: (error: unknown) => boolean;
  readonly onRetry?: (info: RetryAttemptInfo) => void;
  readonly signal?: AbortSignal;
}

/** 退避参数完整形态（解析归一后，字段齐全） */
export interface ResolvedRetryOptions {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 7;
const DEFAULT_INITIAL_DELAY_MS = 1500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER = true;

/** side query 默认重试次数（不含首次）；env 未配置时兜底——与既有 generationConfig.maxRetries 语义一致 */
export const DEFAULT_ENV_RETRY_MAX_RETRIES = 2;

const ENV_RETRY_MAX_ATTEMPTS = 'CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS';
const ENV_RETRY_INITIAL_DELAY_MS = 'CODE_AGENT_MODEL_RETRY_INITIAL_DELAY_MS';
const ENV_RETRY_MAX_DELAY_MS = 'CODE_AGENT_MODEL_RETRY_MAX_DELAY_MS';

type EnvRecord = Record<string, string | undefined>;

/**
 * 解析退避参数：显式 options 优先，环境变量次之，默认值兜底（三层归一）。
 *
 * env 通过参数注入而非直读 process.env——测试可控、复用方不必触碰全局环境。
 * 非法值（非数字/负数）静默忽略落回下一层，调试期用 debug 日志暴露。
 */
export function resolveRetryOptions(
  options: RetryOptions | undefined,
  env: EnvRecord,
): ResolvedRetryOptions {
  const fromEnv = readRetryOptionsFromEnv(env);
  return {
    maxAttempts: normalizePositiveInteger(
      options?.maxAttempts,
      fromEnv.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
    ),
    initialDelayMs: normalizeNonNegativeInteger(
      options?.initialDelayMs,
      fromEnv.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS,
    ),
    maxDelayMs: normalizeNonNegativeInteger(
      options?.maxDelayMs,
      fromEnv.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
    ),
    jitter: options?.jitter ?? DEFAULT_JITTER,
  };
}

/** env 解析出的候选值（字段可缺席，缺席 = 未配置；用显式 undefined 联合而非 Partial 规避 exactOptionalPropertyTypes） */
interface EnvRetryCandidates {
  readonly maxAttempts: number | undefined;
  readonly initialDelayMs: number | undefined;
  readonly maxDelayMs: number | undefined;
}

function readRetryOptionsFromEnv(env: EnvRecord): EnvRetryCandidates {
  return {
    maxAttempts: parseNonNegativeInteger(env[ENV_RETRY_MAX_ATTEMPTS]),
    initialDelayMs: parseNonNegativeInteger(env[ENV_RETRY_INITIAL_DELAY_MS]),
    maxDelayMs: parseNonNegativeInteger(env[ENV_RETRY_MAX_DELAY_MS]),
  };
}

/**
 * 读环境变量的重试次数（不含首次；尝试数 = 次数 + 1），未配置/非法回落默认 2。
 *
 * env 变量（CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS）统一语义为「尝试数（含首次）」，与
 * resolveRetryOptions 一致；本函数是给「以重试次数为语义」的消费方
 * （generationConfig.maxRetries 链路）做的换算出口。
 */
export function resolveEnvRetryMaxRetries(env: EnvRecord): number {
  const parsed = parseNonNegativeInteger(env[ENV_RETRY_MAX_ATTEMPTS]);
  if (parsed === undefined) {
    return DEFAULT_ENV_RETRY_MAX_RETRIES;
  }
  return Math.max(0, parsed - 1);
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizePositiveInteger(...layers: readonly (number | undefined)[]): number {
  for (const value of layers) {
    if (value !== undefined && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
  }
  return 1;
}

function normalizeNonNegativeInteger(...layers: readonly (number | undefined)[]): number {
  for (const value of layers) {
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return 0;
}

/**
 * Retry-After 采纳窗口：值有限且（≤ 5 分钟 或 小于本地指数值）才采纳。
 *
 * 两向防误杀——几小时的 Retry-After 会把请求挂死（用户盯着转圈）；几十秒的合法限流
 * 等待又可能被本地的 30s 封顶截掉。落在窗口内的指示才可信。
 */
const MAX_REASONABLE_RETRY_AFTER_MS = 5 * 60_000;

export function isReasonableRetryAfterMs(
  retryAfterMs: number | undefined,
  exponentialDelayMs: number,
): retryAfterMs is number {
  return (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0 &&
    (retryAfterMs <= MAX_REASONABLE_RETRY_AFTER_MS || retryAfterMs < exponentialDelayMs)
  );
}

/**
 * 延迟决策：合并 Retry-After 采纳窗口、指数曲线与 jitter，产出最终等待值与来源诊断。
 *
 * x-should-retry: false 显式否决供应商重试建议——不采纳其 Retry-After，按本地曲线退避。
 */
export function resolveRetryDelay(input: {
  readonly error: unknown;
  readonly exponentialDelayMs: number;
  readonly jitter: boolean;
}): { readonly delayMs: number; readonly jittered: boolean; readonly source: RetryAfterSource } {
  const headers = input.error instanceof APICallError ? (input.error.responseHeaders ?? {}) : {};
  if (isShouldRetryHeaderBlocked(headers)) {
    const j = applyJitter(input.exponentialDelayMs, input.jitter);
    return { delayMs: j.delayMs, jittered: j.jittered, source: 'blocked_by_x_should_retry' };
  }
  const retryAfterMs = getRetryAfterDelayMs(input.error);
  if (isReasonableRetryAfterMs(retryAfterMs, input.exponentialDelayMs)) {
    // 供应商显式指示优先且不再叠加抖动
    return { delayMs: retryAfterMs, jittered: false, source: 'provider_header' };
  }
  const headerPresent =
    readHeader(headers, 'retry-after') !== undefined ||
    readHeader(headers, 'retry-after-ms') !== undefined;
  const j = applyJitter(input.exponentialDelayMs, input.jitter);
  return {
    delayMs: j.delayMs,
    jittered: j.jittered,
    source: headerPresent ? 'header_unparsed_or_ignored' : 'missing',
  };
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const resolved = resolveRetryOptions(options, {});
  const maxAttempts = resolved.maxAttempts;
  const initialDelayMs = resolved.initialDelayMs;
  const maxDelayMs = resolved.maxDelayMs;
  const shouldRetry = options.shouldRetryOnError ?? isRetryableError;

  let attempt = 1;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const exponentialDelayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const decision = resolveRetryDelay({
        error,
        exponentialDelayMs,
        jitter: resolved.jitter,
      });
      options.onRetry?.({
        attempt,
        error,
        errorStatus: getErrorStatus(error),
        delayMs: decision.delayMs,
        jittered: decision.jittered,
        retryAfterSource: decision.source,
      });
      await sleep(decision.delayMs, options.signal);
      attempt += 1;
    }
  }
}

/**
 * equal jitter：在 [0.5×base, 1.0×base) 均匀取值——保留退避的总量级，打散多调用的重试时刻。
 * base 为 0（零延迟）时无意义，直接原样返回。
 */
function applyJitter(baseMs: number, jitter: boolean): { delayMs: number; jittered: boolean } {
  if (!jitter || baseMs <= 0) {
    return { delayMs: baseMs, jittered: false };
  }
  return { delayMs: Math.round(baseMs * (0.5 + Math.random() * 0.5)), jittered: true };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}
