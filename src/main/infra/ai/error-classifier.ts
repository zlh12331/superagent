// src/main/infra/ai/error-classifier.ts
// AI 调用错误分类器：把未知错误转换为 AppError
// ──────────────────────────────────────────────────────────────
// 职责：
// - 把 streamText / generateText 抛出的各种错误分类为项目标准 AppError
// - 判断是否为用户主动中断（AbortError）
// - 供 ChatService 和 AgentService 共用，避免错误分类逻辑重复
//
// 设计：
// - 完全基于 instanceof 类型守卫，避免脆弱的 message 字符串扫描
// - 分类优先级（从最具体到最宽泛）：
//   1. AppError：已是项目标准错误，直接透传
//   2. APICallError：AI SDK 标准 API 调用错误，按 statusCode 精确分类
//   3. LoadAPIKeyError：AI SDK 加载 API key 失败（keychain/config 缺失）
//   4. TypeError：Node.js 原生 fetch 失败（兜底，理论上 AI SDK 会包装为 APICallError）
//   5. 其他：INTERNAL_ERROR
//
// 使用方式：
// ```ts
// try {
//   await streamText({ ... });
// } catch (error) {
//   if (isAbortError(error)) {
//     // 用户主动中断，不视为错误
//   } else {
//     const appError = classifyError(error);
//     // 推送错误到渲染层
//   }
// }
// ```
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@novel-writer/shared';
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
  // 1. 已是 AppError：直接透传
  if (error instanceof AppError) {
    return error;
  }

  // 2. AI SDK 标准 API 调用错误：按 statusCode + isRetryable 精确分类
  if (error instanceof APICallError) {
    return classifyAPICallError(error);
  }

  // 3. AI SDK 加载 API key 失败（keychain/config 缺失）
  if (error instanceof LoadAPIKeyError) {
    return new AppError(ErrorCode.AI_API_KEY_MISSING, 'API Key 未配置', error);
  }

  // 4. Node.js 原生 fetch 失败（未被 AI SDK 包装的边缘情况）
  if (error instanceof TypeError) {
    return new AppError(ErrorCode.AI_STREAM_INTERRUPTED, '网络连接中断', error);
  }

  // 5. 兜底：未知错误
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

  // 401/403：API key 无效或权限不足
  if (statusCode === 401 || statusCode === 403) {
    return new AppError(ErrorCode.AI_API_KEY_INVALID, 'API Key 无效或已过期', error);
  }

  // 404：模型不存在（用户配置的 modelId 错误）
  if (statusCode === 404) {
    return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型不存在', error);
  }

  // 408：请求超时
  if (statusCode === 408) {
    return new AppError(ErrorCode.AI_TIMEOUT, 'AI 调用超时', error);
  }

  // 413：请求体过大（上下文超限）
  if (statusCode === 413) {
    return new AppError(ErrorCode.AI_CONTEXT_TOO_LARGE, '上下文过长', error);
  }

  // 429：限流
  if (statusCode === 429) {
    return new AppError(ErrorCode.AI_RATE_LIMITED, 'AI 调用过于频繁', error);
  }

  // 5xx：模型服务端异常
  if (statusCode !== undefined && statusCode >= 500) {
    return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型服务异常', error);
  }

  // isRetryable=true：网络层错误（连接中断、DNS 失败等，无明确 statusCode）
  if (isRetryable) {
    return new AppError(ErrorCode.AI_STREAM_INTERRUPTED, '网络连接中断', error);
  }

  // 其他：不可重试 + 未分类状态码，视为模型错误
  return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型服务异常', error);
}
