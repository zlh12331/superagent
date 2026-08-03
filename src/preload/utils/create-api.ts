// src/preload/utils/create-api.ts
// IPC API 自动生成器：遍历 IPC_META 生成 window.api 命名空间
// ──────────────────────────────────────────────────────────────
// 设计：
// - 消费 IPC_META（纯字符串元数据，零 zod 依赖，sandbox 安全）
// - request 方法 → (input) => invoke(channel, input)（复用 ipc-bridge）
// - event 方法 → (callback) => subscribe(channel, callback)（复用 ipc-bridge）
// - 返回类型由 IpcApi 断言（形状由 definitions.ts 推导保证与 meta 同步）
//
// 收益：
// - preload 不再手写任何 IPC 方法（原约 300 行样板代码）
// - 新增 IPC 方法只改 IPC_META + definitions.ts，本文件零改动
// ──────────────────────────────────────────────────────────────

import type { IpcApi, IpcMeta } from '@code-agent/shared';
import { invoke, subscribe } from './ipc-bridge';

/**
 * 从 IPC 元数据表自动生成 window.api 对象
 *
 * @param meta IPC 元数据表（IPC_META）
 * @returns IpcApi 实现（由类型系统保证形状与定义表一致）
 *
 * @example
 * ```ts
 * const api = createIpcApi(IPC_META);
 * contextBridge.exposeInMainWorld('api', api);
 * ```
 */
export function createIpcApi(meta: IpcMeta): IpcApi {
  // 运行时动态构建：遍历每个域的方法，按 kind 绑定 invoke/subscribe
  const api: Record<string, Record<string, unknown>> = {};

  for (const [domain, methods] of Object.entries(meta)) {
    api[domain] = {};
    for (const [method, def] of Object.entries(methods)) {
      if (def.kind === 'request') {
        // 请求-响应：invoke(channel, input)，traceId 由 ipc-bridge 自动注入
        api[domain]![method] = (input: unknown) => invoke(def.channel, input);
      } else {
        // 事件订阅：subscribe(channel, callback)，返回 unsubscribe 函数
        api[domain]![method] = (callback: (payload: unknown) => void) =>
          subscribe(def.channel, callback);
      }
    }
  }

  // 形状由 definitions.ts 的类型推导保证（IpcApi 与 IPC_META 同步）
  return api as unknown as IpcApi;
}
