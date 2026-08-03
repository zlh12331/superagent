// packages/shared/src/preload.ts
// Preload 专用出口：纯字符串 IPC 元数据 + 响应类型（零 zod 依赖，sandbox 安全）
//
// 消费方：src/preload/**
// - IPC_META：createIpcApi 生成器遍历的元数据表（channel + kind，纯字符串）
// - request / event：元数据构造辅助函数
// - IpcResponse：invoke 返回类型（discriminated union）
//
// 为什么独立出口：preload 运行在 sandbox:true 下，import 纯 ESM 包（zod）会静默失败；
// 本出口保证 preload 构建产物零第三方运行时依赖。
// ──────────────────────────────────────────────────────────────

// IPC 错误结构（来自 constants/errors）
export type { IpcError } from './constants/errors';
export type { IpcMeta, MetaEntry } from './ipc/meta';
// IPC 通道元数据（纯字符串，零依赖）
export { event, IPC_META, request } from './ipc/meta';
// IPC 响应类型（invoke 返回值形状）
export type { IpcResponse } from './ipc/response';
