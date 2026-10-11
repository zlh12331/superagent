// error-classifier.ts：错误分类器——裸错误 → AppError 错误码（AI_* 码族），渲染层按码提示
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { APICallError, LoadAPIKeyError } from 'ai';

/** 是否中止类错误（AbortError 名——回合取消/超时统一判据） */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  return false;
}

export function classifyError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof APICallError) {
    return classifyAPICallError(error);
  }

  if (error instanceof LoadAPIKeyError) {
    return new AppError(ErrorCode.AI_API_KEY_MISSING, 'API Key 未配置', error);
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new AppError(ErrorCode.AI_TIMEOUT, 'AI 调用超时', error);
  }

  if (error instanceof TypeError) {
    return new AppError(ErrorCode.AI_STREAM_INTERRUPTED, '网络连接中断', error);
  }

  return new AppError(ErrorCode.INTERNAL_ERROR, 'AI 调用失败', error);
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

function classifyAPICallError(error: APICallError): AppError {
  const { statusCode, isRetryable } = error;
  const errorText = extractErrorText(error);

  // 供应商 context 超限：文案形态优先（多数 provider 用 400 + `context_length_exceeded`
  // 等文案，413 状态码是少数派且同样命中文案）——让用户看到「上下文过长」的明确引导
  // 而非误导性的「模型服务异常」；裸 413（无文案）仍按状态码归类
  if (
    CONTEXT_EXCEEDED_MESSAGE_PATTERN.test(errorText) ||
    (statusCode === 413 && errorText.trim().length === 0)
  ) {
    return new AppError(
      ErrorCode.AI_CONTEXT_TOO_LARGE,
      '上下文超出模型窗口，请精简对话或新建会话',
      error,
    );
  }

  if (statusCode === 413) {
    return new AppError(ErrorCode.AI_CONTEXT_TOO_LARGE, '上下文过长', error);
  }

  if (statusCode === 401 || statusCode === 403) {
    return new AppError(ErrorCode.AI_API_KEY_INVALID, 'API Key 无效或已过期', error);
  }

  if (statusCode === 402) {
    return new AppError(ErrorCode.AI_BALANCE_INSUFFICIENT, '账户余额不足', error);
  }

  if (statusCode === 404) {
    return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型不存在', error);
  }

  if (statusCode === 408) {
    return new AppError(ErrorCode.AI_TIMEOUT, 'AI 调用超时', error);
  }

  if (statusCode === 413) {
    return new AppError(ErrorCode.AI_CONTEXT_TOO_LARGE, '上下文过长', error);
  }

  if (statusCode === 422) {
    return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 请求参数错误', error);
  }

  if (statusCode === 429) {
    return new AppError(ErrorCode.AI_RATE_LIMITED, 'AI 调用过于频繁', error);
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型服务异常', error);
  }

  if (isRetryable) {
    return new AppError(ErrorCode.AI_STREAM_INTERRUPTED, '网络连接中断', error);
  }

  return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型服务异常', error);
}
