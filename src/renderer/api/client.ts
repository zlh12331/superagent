// src/renderer/api/client.ts
// IPC 客户端封装
// 设计文档 §5.1 数据流 / §7.4 错误处理流程
//
// 职责：
// 1. 暴露 window.api 给渲染层（通过 apiClient 别名）
// 2. unwrap() 解包 IpcResponse，失败时抛 AppError

import { AppError, type IpcApi, type IpcResponse } from '@novel-writer/shared';

/**
 * IPC 客户端：复用 preload 注入到 window.api 的 IpcApi 实例
 *
 * 渲染层统一通过 apiClient 调用 IPC，避免直接访问 window.api
 * （方便后续替换 mock 或加埋点）
 *
 * @example
 * const res = await apiClient.project.list();
 */
export const apiClient: IpcApi = window.api;

/**
 * 解包 IpcResponse，失败时抛 AppError
 *
 * IpcResponse 是 discriminated union：`{ data } | { error }`
 * 用 `'data' in res` 进行类型收窄
 *
 * @example
 * const res = await apiClient.project.list();
 * const projects = unwrap(res); // 失败时抛 AppError
 */
export function unwrap<T>(res: IpcResponse<T>): T {
  if ('data' in res) {
    return res.data;
  }
  // 失败：将 IpcError 还原为 AppError 抛出
  // cause 显式传 undefined（IPC 传输不包含原始 cause 链）
  // details 透传给 AppError，便于渲染层调试
  throw new AppError(res.error.code, res.error.message, undefined, res.error.details);
}
