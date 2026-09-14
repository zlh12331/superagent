// packages/shared/src/renderer.ts
// 渲染层专用出口：类型契约 + 轻量常量（无 zod schema 运行时）
//
// 消费方：src/renderer/**（24 个文件）
// - IpcApi：window.api 完整形状（自动推导，享受智能提示）
// - IpcResponse / IpcRequestMap / IpcEventMap：IPC 类型映射（纯类型）
// - IPC_CHANNELS：通道常量（值，零依赖）
// - ERROR_META：错误码元数据（值）
//
// 设计目标：渲染层只获取类型契约与轻量常量，不加载 zod schema 运行时，
// 保持打包体积最小、依赖边界清晰（主进程专属逻辑不泄漏到浏览器环境）。
// ──────────────────────────────────────────────────────────────

export { REMEMBER_TTL_MINUTES } from './constants/approval';
export {
  ATTACHMENT_MAX_CHARS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  MAX_MESSAGE_LENGTH_CHARS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from './constants/defaults';
export type { ErrorMeta, IpcError } from './constants/errors';
// 错误码与错误元数据（值 + 类型）
export { ERROR_META, ErrorCode } from './constants/errors';
export { IPC_PROTOCOL_VERSION } from './constants/protocol';
// IPC 类型契约（纯类型，自动推导）
export type { IpcApi } from './ipc/api';
export type { IpcChannel } from './ipc/channels';
// IPC 通道常量（值，零 zod 依赖）
export { IPC_CHANNELS } from './ipc/channels';
// 类型定义表（仅类型，供推导消费）
export type { IpcDefinitions } from './ipc/definitions';
// IPC 类型映射（Req/Res 别名，由 IpcRequestMap 推导）
export type * from './ipc/payloads';
export type { IpcEventMap, IpcRequestMap } from './ipc/payloads';
export type { IpcResponse } from './ipc/response';
// zod schema 的类型部分（仅类型重导出，不携带 schema 运行时）
export type * from './schemas/agent';
export type * from './schemas/agent-ask';
export type * from './schemas/agent-events';
export type * from './schemas/app';
export type * from './schemas/browser';
export type * from './schemas/chat';
export type * from './schemas/codebase';
export type * from './schemas/devtools';
export type * from './schemas/dialog';
export type * from './schemas/file';
export type * from './schemas/git';
export type * from './schemas/goal';
export type * from './schemas/im';
export type * from './schemas/memory';
export type * from './schemas/models';
export type * from './schemas/remote';
export type * from './schemas/search';
export type * from './schemas/session';
export type * from './schemas/settings';
export type { SettingKey } from './schemas/settings';
// settings:set 可写键白名单（值：遗留 localStorage 迁移过滤用；schema 内含 lsp 值级门禁）
export { SETTING_KEYS } from './schemas/settings';
export type * from './schemas/skill';
export type * from './schemas/system';
export type * from './schemas/task';
export type * from './schemas/terminal';
export type * from './schemas/thinking';
export type * from './schemas/tool';
export type * from './schemas/update';
export type * from './schemas/whitelist';
