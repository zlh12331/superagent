// packages/shared/src/index.ts
// @novel-writer/shared 跨进程共享包统一入口
// 暴露：错误码 + IPC 类型契约（应用级）
//
// 消费方：
// - 主进程：import { AppError, ErrorCode, IPC_CHANNELS } from '@novel-writer/shared'
// - Preload：import type { IpcApi } from '@novel-writer/shared'
// - 渲染层：import type { IpcResponse, AppStatus } from '@novel-writer/shared'
//
// 说明：业务相关导出（schemas/types/enums/age/pg-versions）已随数据库层一并删除，
// 当前仅保留通用基础设施（错误码 + IPC 类型契约 + 应用级 payload）。

// 错误处理（§7）
export * from './constants/errors';

// IPC 类型契约（§5）
export * from './ipc/api';
export * from './ipc/channels';
export * from './ipc/payloads';
export * from './ipc/response';

// 包版本（供运行时 sanity check）
export const SHARED_VERSION = '0.1.0' as const;
