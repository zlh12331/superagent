import type { IPC_DEFINITIONS } from './definitions';
import type { InferIpcApi } from './derive';

/**
 * IpcApi 接口：window.api 完整形状（自动推导）
 *
 * 每个域包含：
 * - 请求-响应方法（invoke 模式）：通过 ipcRenderer.invoke 调用主进程 handler
 * - 事件订阅方法（subscribe 模式）：通过 ipcRenderer.on 注册监听器，返回 unsubscribe 函数
 *
 * 类型契约：
 * - 所有方法签名从 IPC_DEFINITIONS 派生，避免手写类型
 * - 请求-响应方法的返回值统一为 Promise<IpcResponse<T>>（discriminated union）
 * - 事件订阅方法的回调参数类型与定义表 payload 严格对齐
 */
export type IpcApi = InferIpcApi<typeof IPC_DEFINITIONS>;

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}
