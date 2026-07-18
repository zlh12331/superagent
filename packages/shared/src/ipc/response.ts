// packages/shared/src/ipc/response.ts
// IPC 统一返回结构 + IpcContext
// 设计文档 §7.4 错误处理流程：handler wrap() 返回 { data } | { error }

import type { IpcError } from '../constants/errors';

/**
 * IPC 统一响应结构
 *
 * 成功：{ data: T }
 * 失败：{ error: IpcError }
 *
 * 使用 discriminated union，渲染层可通过 'data' in resp 判断
 */
export type IpcResponse<T> = { readonly data: T } | { readonly error: IpcError };

/**
 * IPC handler 上下文
 *
 * 由 wrap() 注入，包含 traceId 和 sender 校验信息
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry（设计文档 §4.7）
 */
export interface IpcContext {
  /** 贯穿链路的 traceId（渲染层可显式传入，否则主进程生成） */
  readonly traceId: string;
  /** 调用方 WebContents（用于反向推送流式事件） */
  readonly sender: unknown;
}

/** 流式事件订阅器（渲染层用，返回 unsubscribe 函数） */
export type StreamSubscriber<TPayload> = (callback: (payload: TPayload) => void) => () => void;
