// api.ts：window.api 的类型契约 —— IpcApi 从 IPC_DEFINITIONS 自动推导，本文件不手写任何方法签名
// 边界：preload 按此类型实现并经 contextBridge 暴露为 window.api；新增/改动 IPC 方法只编辑 meta.ts + definitions.ts，此处与消费侧自动同步

import type { IPC_DEFINITIONS } from './definitions';
import type { InferIpcApi } from './derive';

/**
 * window.api 的完整形状（由 IPC_DEFINITIONS 自动推导，禁止手写）
 *
 * 每个域含两类成员：
 * - 请求-响应（invoke）：调用主进程 handler，返回值统一为 Promise<IpcResponse<T>>，成功取 { data }、失败取 { error }
 * - 事件订阅（subscribe）：注册监听器并返回 unsubscribe 函数，回调 payload 类型与定义表严格对齐
 *
 * 渲染层读取返回值一律经 src/renderer/lib/ipc.ts 的 unwrap()，勿手写 `'data' in resp` 判别。
 */
export type IpcApi = InferIpcApi<typeof IPC_DEFINITIONS>;

// 全局只声明一次：渲染层各处直接使用 window.api，无需重复扩展 Window
declare global {
  interface Window {
    api: IpcApi;
  }
}
