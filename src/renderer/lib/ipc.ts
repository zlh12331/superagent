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
 * @throws Error 当响应为 error，或既无 data 也无 error（协议异常）
 */
export function unwrap<T>(response: IpcResponse<T>): T {
  if ('error' in response) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  return response.data;
}
