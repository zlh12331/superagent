// src/renderer/lib/ipc.ts
// IPC 响应解包工具（渲染层共用）
// ──────────────────────────────────────────────────────────────
// 设计动机（可维护性 · DRY）：
// - unwrap 此前在 use-telemetry.ts / use-api-key.ts / SettingsDialog.tsx 各复制一份，
//   逻辑完全相同。抽到此处单一真源，三处改 import。
// - 基于 shared 的 IpcResponse（discriminated union：{ data } | { error }）。
// ──────────────────────────────────────────────────────────────

import type { IpcResponse } from '@code-agent/shared/renderer';

/**
 * 解包 IPC 响应（discriminated union）
 *
 * - 成功：返回 data
 * - 失败：抛 Error（格式 `[CODE] message`，供上层 toast/本地化）
 *
 * @throws Error 当响应为 error、data 缺失（协议异常）、或既无 data 也无 error 时
 */
export function unwrap<T>(response: IpcResponse<T>): T {
  if ('error' in response) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  if (response.data === undefined) {
    // 既无 error 也无 data = 协议异常（正常响应必为 { data } | { error } 二选一）
    throw new Error('[INVALID_RESPONSE] IPC 响应缺少 data（协议异常）');
  }
  return response.data;
}

/** 匹配 unwrap 抛出错误前缀 `[CODE]` 中的错误码形态 */
const ERROR_CODE_PREFIX = /^\[([A-Z_]+)\]/;

/**
 * 错误 → 用户可见文案（unwrap 抛出的 `[CODE] message` 的统一解析口）
 *
 * - 前缀含错误码 → 交给 localize 做 i18n（调用方传 getErrorMessage）
 * - 无前缀 / localize 抛错 → 回退原始 message（绝不让调用方的 onError 抛错）
 *
 * 单一真源：此前该逻辑在 AsyncBoundary / ChatPanel / error-actions 各抄一份
 * （2026-09 一致性审计收敛项）。
 */
export function unwrapErrorMessage<C extends string>(
  error: Error,
  localize: (code: C) => string,
): string {
  const match = error.message.match(ERROR_CODE_PREFIX);
  if (match === null) {
    return error.message;
  }
  const code = match[1];
  if (code === undefined) {
    return error.message;
  }
  try {
    // 正则形态约束（[A-Z_] 大写码）与调用方错误码联合的契约收窄点
    return localize(code as C);
  } catch {
    return error.message;
  }
}
