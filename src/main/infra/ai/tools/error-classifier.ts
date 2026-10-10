import { AppError, ErrorCode } from '@code-agent/shared/main';
import { APICallError, LoadAPIKeyError } from 'ai';

/**
 * 判断是否为 AbortError
 *
 * 不同运行时 AbortError 的 name 可能不同：
 * - 浏览器/Electron：AbortError
 * - Node.js fetch：AbortError
 * - 自定义 controller.abort() 触发的：AbortError
 *
 * AbortError 视为用户主动中断，不作为错误处理（不推送 error 事件）。
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  return false;
}

/**
 * 错误分类：把未知错误转换为 AppError
 *
 * @param error streamText / generateText 抛出的未知错误
 * @returns 对应的 AppError，携带标准错误码与人类可读消息
 */
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
 * 分类 APICallError：按 HTTP statusCode 精确映射 ErrorCode
 *
 * @param error AI SDK 抛出的 APICallError，含 statusCode / isRetryable / responseBody
 * @returns 对应的 AppError，附带 statusCode 用于渲染层诊断
 */
function classifyAPICallError(error: APICallError): AppError {
  const { statusCode, isRetryable } = error;

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
