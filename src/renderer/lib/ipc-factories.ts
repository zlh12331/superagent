// src/renderer/lib/ipc-factories.ts
// IPC mock 响应工厂（dev mock 与测试 mock 共用单一真源）
// ──────────────────────────────────────────────────────────────
// 背景：mock-api.ts（dev:web 预览）与 test/msw-handlers.ts（测试）此前
// 各自实现一份 ok/err 响应构造，结构相同却双写。收敛到此处共用。
// ──────────────────────────────────────────────────────────────

import type { IpcResponse } from '@code-agent/shared/renderer';

/** 成功响应（{ data: T }） */
export function ipcOk<T>(data: T): IpcResponse<T> {
  return { data };
}

/** 错误响应（{ error: { code, message } }；code 串由调用方保证合法 ErrorCode） */
export function ipcErr(code: string, message: string): IpcResponse<never> {
  return { error: { code, message } } as IpcResponse<never>;
}
