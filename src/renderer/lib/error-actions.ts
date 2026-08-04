// src/renderer/lib/error-actions.ts
// 错误码 → 恢复动作注册表（错误处理扩展）
// ──────────────────────────────────────────────────────────────
// 背景：AsyncBoundary 默认错误态提供「重试」按钮，但部分错误码需要
// 业务恢复动作（如 API Key 缺失 → 打开设置配置密钥）。本注册表
// 统一映射「错误码 → 恢复动作」，跨模块行为一致。
//
// 使用：parseErrorCode(error) 解析错误码（约定格式 "[CODE] message"），
// resolveErrorAction(error) 查注册表；未注册的错误码只显示默认重试。
// ──────────────────────────────────────────────────────────────

import { ErrorCode, type ErrorCode as ErrorCodeType } from '@code-agent/shared/renderer';

/** 错误恢复动作类型 */
export type ErrorAction = { readonly kind: 'open-settings' } | { readonly kind: 'retry' };

/**
 * 错误码 → 恢复动作映射
 *
 * 仅登记需要「默认重试之外」的业务动作：
 * - AI_API_KEY_MISSING / AI_API_KEY_INVALID → 打开设置配置密钥
 * - 其余错误码依赖默认重试按钮（RATE_LIMITED 等由 TanStack Query 自动重试兜底）
 */
const ERROR_ACTION_MAP: Readonly<Partial<Record<ErrorCodeType, ErrorAction>>> = {
  [ErrorCode.AI_API_KEY_MISSING]: { kind: 'open-settings' },
  [ErrorCode.AI_API_KEY_INVALID]: { kind: 'open-settings' },
};

/**
 * 从 Error 解析错误码（约定错误格式 "[CODE] message"）
 *
 * 与 AsyncBoundary 的错误文案解析共用同一约定；非合法错误码返回 undefined。
 *
 * @param error 原始错误
 * @returns 合法错误码，无法解析返回 undefined
 */
export function parseErrorCode(error: Error): ErrorCodeType | undefined {
  const codeMatch = /^\[([A-Z_]+)\]/.exec(error.message);
  if (codeMatch === null) {
    return undefined;
  }
  const candidate = codeMatch[1] ?? '';
  // 校验候选码确为合法 ErrorCode（防御任意字符串被当作错误码）
  const validCodes: readonly string[] = Object.values(ErrorCode);
  return validCodes.includes(candidate) ? (candidate as ErrorCodeType) : undefined;
}

/**
 * 解析错误 → 恢复动作
 *
 * @param error 原始错误
 * @returns 注册的恢复动作；未注册返回 undefined（调用方使用默认重试）
 */
export function resolveErrorAction(error: Error): ErrorAction | undefined {
  const code = parseErrorCode(error);
  if (code === undefined) {
    return undefined;
  }
  return ERROR_ACTION_MAP[code];
}
