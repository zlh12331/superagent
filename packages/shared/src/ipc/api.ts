// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义（从 IPC_DEFINITIONS 自动推导）
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明
//
// 本文件不再手写接口：IpcApi 由 InferIpcApi(IPC_DEFINITIONS) 推导，
// 新增/修改 IPC 方法只需编辑 definitions.ts，接口自动同步。
//
// 域划分（Code Agent 架构）：
// - app：应用级 API（getStatus / openExternal）
// - chat：聊天域 API（Vercel AI SDK v7，保留兼容；单轮对话走此通道）
// - agent：Code Agent 核心 API（多轮工具调用 + 流式事件 + 审批回传）
// - session：会话持久化 API（基于 SQLite + Drizzle）
// - file：文件读写 API（支持大文件分批 + 文件监听）
// - search：搜索 API（ripgrep + glob）
// - terminal：终端会话 API（node-pty 会话池 + 流式输出）
// - git：Git 操作 API（status / diff / add / commit / push）
// - codebase：代码智能 API（codegraph CLI 封装）
// - tool：工具系统元数据 API（tool:list）
// - settings / system / logs / devtools / dialog：基础设施域

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
