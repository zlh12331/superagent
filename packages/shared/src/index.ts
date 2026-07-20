// packages/shared/src/index.ts
// @novel-writer/shared 跨进程共享包统一入口
// 暴露：错误码 + 业务实体类型 + Zod schema + IPC 类型契约
//
// 消费方：
// - 主进程：import { AppError, ErrorCode, ProjectCreateInputSchema } from '@novel-writer/shared'
// - Preload：import type { IpcApi } from '@novel-writer/shared'
// - 渲染层：import type { Project, IpcResponse } from '@novel-writer/shared'

// Apache AGE 图数据常量（§6.3）
export * from './constants/age';
// 错误处理（§7）
export * from './constants/errors';
// PostgreSQL 版本常量（§6.5 AGE 兼容性策略）
export * from './constants/pg-versions';

// IPC 类型契约（§5）
export * from './ipc/api';
export * from './ipc/channels';
export * from './ipc/payloads';
export * from './ipc/response';

// Zod schema + CRUD Input（运行时校验 + 类型派生）
// 此处 export * 会让 schemas 派生的 Project/Chapter/... 成为对外唯一类型来源
export * from './schemas';

// 业务实体类型与枚举（§6.2）
// 类型真理源策略：所有可在 IPC 边界校验的实体类型由 schemas 派生（z.infer）
// types/models 仅保留 schemas 未覆盖的独有类型：
// - ISODateString / Volume / CharacterRelation / RagDocumentChunk / AiUsageLog
export * from './types/enums';
export type {
  AiUsageLog,
  CharacterRelation,
  ISODateString,
  RagDocumentChunk,
  Volume,
} from './types/models';

// 包版本（供运行时 sanity check）
export const SHARED_VERSION = '0.1.0' as const;
