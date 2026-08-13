// packages/shared/src/main.ts
// 主进程专用出口：zod schema（运行时校验）+ 定义表 + 通道常量 + handler 类型
//
// 消费方：src/main/**（69 个文件）
// - 运行时：IPC_DEFINITIONS（handler 注册）、IPC_CHANNELS、各 ReqSchema（wrap 校验）、
//   AppError / ErrorCode（错误处理）
// - 类型：InferHandlers（handler 对象编译期一致性约束）
//
// 依赖说明：本出口含 zod 运行时，仅供主进程（Node 环境）使用；
// preload（sandbox 沙箱）与渲染层（浏览器）应使用各自专用出口。
// ──────────────────────────────────────────────────────────────

// 错误处理（§7）
export * from './constants/errors';
export * from './constants/protocol';
export type { IpcChannel } from './ipc/channels';
// IPC 通道常量（值，零 zod 依赖，主进程 handler 注册用）
export { IPC_CHANNELS } from './ipc/channels';
export type { IpcDefinitions } from './ipc/definitions';
// IPC 定义表（含 zod schema 运行时）
export { IPC_DEFINITIONS, withPayload, withSchema } from './ipc/definitions';
// 类型推导工具（InferHandlers 供 handler 对象编译期一致性约束）
export type {
  HandlerSignature,
  InferEventMap,
  InferHandlers,
  InferIpcApi,
  InferRequestMap,
} from './ipc/derive';

// IPC 类型映射（Req/Res 别名，handler 入参/返回类型）
export type * from './ipc/payloads';
// IPC 响应类型（wrap 返回结构）
export type { IpcResponse } from './ipc/response';

// zod schema（单一真源，主进程 IPC handler 用于校验入参）
export * from './schemas/agent';
export * from './schemas/agent-ask';
export * from './schemas/agent-events';
export * from './schemas/app';
export * from './schemas/chat';
export * from './schemas/codebase';
export * from './schemas/devtools';
export * from './schemas/dialog';
export * from './schemas/file';
export * from './schemas/git';
export * from './schemas/goal';
export * from './schemas/im';
export * from './schemas/mcp';
export * from './schemas/memory';
export * from './schemas/models';
export * from './schemas/search';
export * from './schemas/session';
export * from './schemas/settings';
export * from './schemas/skill';
export * from './schemas/system';
export * from './schemas/task';
export * from './schemas/terminal';
export * from './schemas/thinking';
export * from './schemas/tool';
export * from './schemas/update';
export * from './schemas/whitelist';
