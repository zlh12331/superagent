// model-failure.ts：模型失败三轴契约——code（是什么）/ reason（归因）/ retryReason（处置），
// 由 error-classifier 归一产出，闸门冷却/重试决策/渲染层提示/降级路由各取所需轴
// 参照 zcode ClassifiedModelFailure 设计；值与 ErrorCode.AI_* 码族对齐（渲染层 i18n 零新文案）

/**
 * 模型失败码（是什么）。
 *
 * 值与 ErrorCode.AI_* 同名对齐——消费方（渲染层 i18n `errors.<code>`、TurnErrorNotice）
 * 无需新增文案；新增失败形态时在此扩展，不再往 ErrorCode 塞只有模型域用的值。
 */
export const ModelErrorCode = {
  /** 请求被调用方中止（对照 AbortSignal 判定，非供应商失败） */
  ModelRequestCancelled: 'model_request_cancelled',
  /** 请求超出供应商上下文窗口（不可重试——重试必然再失败，上层走压缩/新会话引导） */
  ModelContextExceeded: 'model_context_exceeded',
  /** 供应商限流（429；附 retryAfterMs 时闸门按它冷却） */
  ModelRateLimited: 'model_rate_limited',
  /** 请求超时（总超时或连接超时） */
  ModelRequestTimeout: 'model_request_timeout',
  /** 流空闲超时（流式响应相邻 chunk 间隔超限——与总超时区分：流还活着只是卡了） */
  ModelStreamIdleTimeout: 'model_stream_idle_timeout',
  /** 供应商服务端错误（5xx） */
  ModelServerError: 'model_server_error',
  /** 网络层失败（连接重置/拒绝/DNS/socket 断——cause 链裁决后的确定性网络错） */
  ModelNetworkError: 'model_network_error',
  /** TLS 握手/证书失败（与普通网络错区分：用户需检查代理或系统时间） */
  ModelTlsError: 'model_tls_error',
  /** 代理失败（本机代理配置问题） */
  ModelProxyError: 'model_proxy_error',
  /** 凭据失败（401/403 或 Key 格式错——不可重试，需用户换 Key） */
  ModelAuthFailed: 'model_auth_failed',
  /** 账户余额不足（402 或供应商业务码） */
  ModelBalanceInsufficient: 'model_balance_insufficient',
  /** 模型不存在（404 或供应商未收录的模型 id） */
  ModelNotFound: 'model_not_found',
  /** 请求参数非法（422/400 参数错——SDK 层或供应商校验拒绝） */
  ModelInvalidRequest: 'model_invalid_request',
  /** 模型响应无法解析（SSE 结构/工具调用块损坏——部分可重试） */
  ModelInvalidResponse: 'model_invalid_response',
  /** 模型流正常结束但零内容零工具（空响应——单独一轴便于统计与空补全重试） */
  ModelEmptyResponse: 'model_empty_response',
  /** 未分类失败（兜底——分类器穷尽形态后仍不认识的错误） */
  ModelUnknown: 'model_unknown',
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

/**
 * 失败归因（在哪一侧）。
 *
 * 降级路由的依据：只有 `provider` 归因才值得换模型重试——把本地配置错误
 * （Runtime）记到 provider 头上会让降级对供应商失败率统计失真。
 */
export const ModelFailureReason = {
  /** 本机网络层（连接/超时/socket——请求可能根本没到供应商） */
  NetworkError: 'network_error',
  /** 本机代理问题 */
  ProxyError: 'proxy_error',
  /** TLS 层 */
  TlsError: 'tls_error',
  /** 供应商侧（收到响应或已进入 SSE body——有明确上游边界事实） */
  Provider: 'provider',
  /** 调用方运行时（本地配置校验失败、请求未发出即拒绝） */
  Runtime: 'runtime',
  /** 调用方主动取消 */
  Cancelled: 'cancelled',
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

/**
 * 重试处置理由（为什么可/不可重试）。
 *
 * 与 retryable 布尔分离：同样的"可重试"，429 要带 Retry-After 等待、5xx 要指数退避、
 * 流空闲要重建连接——处置动作不同；闸门冷却只认 `rate_limited` 一档。
 */
export const ModelRetryReason = {
  /** 服务端错误（5xx——指数退避重试） */
  ServerError: 'server_error',
  /** 限流（429——按 Retry-After/冷却等待） */
  RateLimited: 'rate_limited',
  /** 网络抖动（连接级——重建连接重试） */
  NetworkError: 'network_error',
  /** 流卡死（空闲超时——重建流重试） */
  StreamIdleTimeout: 'stream_idle_timeout',
  /** 总超时（请求整体超时——可重试但计入预算更紧） */
  Timeout: 'timeout',
  /** 认证刷新后可重试（refresh token 流程成功后） */
  AuthRefresh: 'auth_refresh',
  /** 供应商标记不可重试（x-should-retry: false 或业务码否定） */
  ProviderBlocked: 'provider_blocked',
  /** 不可重试（语义性失败：context 超限/参数错/余额不足——重试必然再失败） */
  NotRetryable: 'not_retryable',
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

/** 模型失败的结构化全貌（分类器唯一产出形态——错误是数据，不是布尔） */
export interface ModelFailure {
  readonly code: ModelErrorCode;
  readonly reason: ModelFailureReason;
  readonly retryReason: ModelRetryReason;
  readonly retryable: boolean;
  /** 供应商 Retry-After 指示（毫秒；未经采纳窗口裁决的原始值，裁决在重试执行器） */
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  /** 供应商业务码/错误标识（诊断用，随日志与观测同源透传） */
  readonly providerErrorCode?: string;
  /** 人类可读摘要（分类器归一后的 message，兜底用原始 error.message） */
  readonly message: string;
}
