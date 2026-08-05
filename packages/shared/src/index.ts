// packages/shared/src/index.ts
// @code-agent/shared 跨进程共享包统一入口
// 暴露：错误码 + IPC 类型契约（应用级 + Code Agent 全域）+ zod schema
//
// 消费方：
// - 主进程：import { AppError, ErrorCode, IPC_CHANNELS, ChatSendReqSchema } from '@code-agent/shared'
// - Preload：import type { IpcApi } from '@code-agent/shared'
// - 渲染层：import type { IpcResponse, AppStatus } from '@code-agent/shared'
//
// P1 改造（Code Agent 架构）：
// - 新增 6 个域的 zod schema（agent/file/search/terminal/git/session）
// - 新增对应 IPC payload 类型映射（见 ./ipc/payloads.ts）
// - 所有 schema 均为单一真源，主进程 IPC handler 用于校验入参，避免类型与 schema 双向漂移

// 错误处理（§7）
export * from './constants/errors';

// IPC 类型契约（§5）
export * from './ipc/api';
export * from './ipc/channels';
export * from './ipc/definitions';
export * from './ipc/derive';
export * from './ipc/meta';
export * from './ipc/payloads';
export * from './ipc/response';

// zod schema（单一真源，主进程 IPC handler 用于校验入参）
// 按域分组：agent（Code Agent 核心）/ chat（基础聊天）/ file/search（只读工具）
// / terminal/git（读写工具）/ codebase（代码智能查询）/ session（持久化）/ tool（工具系统元数据）
// / system（运行时可观测性）/ settings（API Key 管理）/ devtools（开发者工具集成）
// 顺序由 Biome organizeImports 规则按字母序维护
export * from './schemas/agent';
export * from './schemas/agent-events';
export * from './schemas/chat';
export * from './schemas/codebase';
export * from './schemas/devtools';
export * from './schemas/dialog';
export * from './schemas/file';
export * from './schemas/git';
export * from './schemas/goal';
export * from './schemas/im';
export * from './schemas/memory';
export * from './schemas/search';
export * from './schemas/session';
export * from './schemas/settings';
export * from './schemas/skill';
export * from './schemas/system';
export * from './schemas/task';
export * from './schemas/terminal';
export * from './schemas/tool';

// 包版本（供运行时 sanity check）
export const SHARED_VERSION = '0.1.0' as const;
