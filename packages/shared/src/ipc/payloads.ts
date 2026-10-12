// payloads.ts：IPC payload 类型层——汇集各域 Req 类型（一律 z.infer 自 zod schema）与两张 channel 类型映射
// 边界：不定义字段与运行时逻辑（字段语义以 packages/shared/src/schemas/ 下的 schema 为单一真源）；映射从 definitions.ts 的定义表整体推导，新增 channel 无需改本文件

import type { z } from 'zod';
import type {
  AgentApprovalResponseReqSchema,
  AgentRunReqSchema,
  AgentStopReqSchema,
} from '../schemas/agent';
import type {
  FileCreateDirReqSchema,
  FileCreateReqSchema,
  FileDeleteReqSchema,
  FileListReqSchema,
  FileReadReqSchema,
  FileRenameReqSchema,
  FileWatchStartReqSchema,
  FileWatchStopReqSchema,
  FileWriteReqSchema,
} from '../schemas/file';
import type {
  GitAddReqSchema,
  GitCommitReqSchema,
  GitDiffReqSchema,
  GitPushReqSchema,
  GitStatusReqSchema,
} from '../schemas/git';
import type { GlobReqSchema, GrepReqSchema } from '../schemas/search';
import type {
  SessionCreateReqSchema,
  SessionDeleteReqSchema,
  SessionGetReqSchema,
  SessionListRecentDirsReqSchema,
  SessionListReqSchema,
  SessionRenameReqSchema,
} from '../schemas/session';
import type {
  DeleteApiKeyReqSchema,
  GetApiKeyReqSchema,
  SetApiKeyReqSchema,
  SetTelemetryLevelReqSchema,
} from '../schemas/settings';
import type {
  TerminalCreateReqSchema,
  TerminalInputReqSchema,
  TerminalKillReqSchema,
  TerminalResizeReqSchema,
} from '../schemas/terminal';
import type { ToolListReqSchema } from '../schemas/tool';
import type { IPC_DEFINITIONS } from './definitions';
import type { InferEventMap, InferRequestMap } from './derive';

// ChatMessage 转发自 schemas/chat.ts（= AI SDK 的 ModelMessage）
export type { ChatMessage } from '../schemas/chat';

// ─── 应用级 payload ───

/**
 * app:getStatus 响应：应用就绪标记 + IPC 协议版本
 *
 * 渲染层挂载时（src/renderer/hooks/use-protocol-check.ts）取 protocolVersion 与本地
 * IPC_PROTOCOL_VERSION（packages/shared/src/constants/protocol.ts）比对：不一致 = 主进程与
 * 渲染层来自不同构建（自动更新后单侧先更新），仅提示重启，不阻断功能。
 */
export interface AppStatus {
  /** 应用是否已就绪（true = 主进程初始化完成） */
  readonly ready: boolean;
  /** IPC 协议版本（契约兼容性版本，非应用版本号；对照常量见上方 TSDoc） */
  readonly protocolVersion: number;
}

// ─── Agent 域 Req ───

/** agent:run 请求 payload：发起一次 agent 对话 */
export type AgentRunReq = z.infer<typeof AgentRunReqSchema>;

/** agent:stop 请求 payload：中断指定 sessionId 的 agent 对话 */
export type AgentStopReq = z.infer<typeof AgentStopReqSchema>;

/** agent:approval:response 请求 payload：渲染层回传审批结果 */
export type AgentApprovalResponseReq = z.infer<typeof AgentApprovalResponseReqSchema>;

// ─── File 域 Req ───

/** file:read 请求 payload：读取文件内容（支持分批） */
export type FileReadReq = z.infer<typeof FileReadReqSchema>;

/** file:write 请求 payload：写入文件（覆盖或追加） */
export type FileWriteReq = z.infer<typeof FileWriteReqSchema>;

/** file:list 请求 payload：列出目录内容 */
export type FileListReq = z.infer<typeof FileListReqSchema>;

/** file:watch:start 请求 payload：开始监听文件变更 */
export type FileWatchStartReq = z.infer<typeof FileWatchStartReqSchema>;

/** file:watch:stop 请求 payload：停止监听指定 watcher */
export type FileWatchStopReq = z.infer<typeof FileWatchStopReqSchema>;

/** file:create 请求 payload：创建新文件 */
export type FileCreateReq = z.infer<typeof FileCreateReqSchema>;

/** file:createDir 请求 payload：创建新目录 */
export type FileCreateDirReq = z.infer<typeof FileCreateDirReqSchema>;

/** file:delete 请求 payload：删除文件或目录 */
export type FileDeleteReq = z.infer<typeof FileDeleteReqSchema>;

/** file:rename 请求 payload：重命名/移动文件或目录 */
export type FileRenameReq = z.infer<typeof FileRenameReqSchema>;

// ─── Search 域 Req（grep 由 ripgrep 驱动，见 src/main/infra/search/search-service.ts） ───

/** search:grep 请求 payload：正则搜索文件内容 */
export type GrepReq = z.infer<typeof GrepReqSchema>;

/** search:glob 请求 payload：glob 模式匹配文件路径 */
export type GlobReq = z.infer<typeof GlobReqSchema>;

// ─── Terminal 域 Req（node-pty 会话池） ───

/** terminal:create 请求 payload：创建终端会话 */
export type TerminalCreateReq = z.infer<typeof TerminalCreateReqSchema>;

/** terminal:input 请求 payload：向终端写入输入 */
export type TerminalInputReq = z.infer<typeof TerminalInputReqSchema>;

/** terminal:resize 请求 payload：调整终端尺寸 */
export type TerminalResizeReq = z.infer<typeof TerminalResizeReqSchema>;

/** terminal:kill 请求 payload：终止终端会话 */
export type TerminalKillReq = z.infer<typeof TerminalKillReqSchema>;

// ─── Git 域 Req（经 simple-git 驱动 git CLI） ───

/** git:status 请求 payload：获取工作区状态 */
export type GitStatusReq = z.infer<typeof GitStatusReqSchema>;

/** git:diff 请求 payload：获取 diff */
export type GitDiffReq = z.infer<typeof GitDiffReqSchema>;

/** git:add 请求 payload：暂存工作区改动（git add） */
export type GitAddReq = z.infer<typeof GitAddReqSchema>;

/** git:commit 请求 payload：提交暂存区改动（git commit） */
export type GitCommitReq = z.infer<typeof GitCommitReqSchema>;

/** git:push 请求 payload：推送本地提交到远程（git push） */
export type GitPushReq = z.infer<typeof GitPushReqSchema>;

// ─── Session 域 Req ───

/** session:list 请求 payload：分页列出会话 */
export type SessionListReq = z.infer<typeof SessionListReqSchema>;

/** session:get 请求 payload：获取完整会话消息历史 */
export type SessionGetReq = z.infer<typeof SessionGetReqSchema>;

/** session:delete 请求 payload：删除会话 */
export type SessionDeleteReq = z.infer<typeof SessionDeleteReqSchema>;

/** session:rename 请求 payload：重命名会话 */
export type SessionRenameReq = z.infer<typeof SessionRenameReqSchema>;

/** session:create 请求 payload */
export type SessionCreateReq = z.infer<typeof SessionCreateReqSchema>;

/** session:listRecentDirs 请求 payload */
export type SessionListRecentDirsReq = z.infer<typeof SessionListRecentDirsReqSchema>;

// ─── Tool 域 Req ───

/** tool:list 请求 payload：列出已注册工具清单（可按权限过滤） */
export type ToolListReq = z.infer<typeof ToolListReqSchema>;

// ─── Settings 域 Req ───

/** settings:getApiKey 请求 payload：查询指定提供商的 API Key */
export type GetApiKeyReq = z.infer<typeof GetApiKeyReqSchema>;

/** settings:setApiKey 请求 payload：设置 API Key */
export type SetApiKeyReq = z.infer<typeof SetApiKeyReqSchema>;

/** settings:deleteApiKey 请求 payload：删除指定提供商的 API Key */
export type DeleteApiKeyReq = z.infer<typeof DeleteApiKeyReqSchema>;

/** settings:setTelemetryLevel 请求 payload：设置遥测级别 */
export type SetTelemetryLevelReq = z.infer<typeof SetTelemetryLevelReqSchema>;

// ─── 非 z.infer 派生的转发（接口 / 联合 / 枚举 + 对应 schema 值） ───

export type { OpenDevToolsReq, OpenDevToolsRes } from '../schemas/devtools';
export { OpenDevToolsReqSchema } from '../schemas/devtools';
export type {
  GetTelemetryLevelRes,
  SetTelemetryLevelRes,
  TelemetryLevel,
} from '../schemas/settings';
export { SetTelemetryLevelReqSchema, TelemetryLevelSchema } from '../schemas/settings';

// ─── IPC 类型映射 ───

/**
 * 请求-响应 channel 的类型映射：channel → { req, res }
 *
 * - req：渲染层 invoke 传出的入参形状，取 schema 的 z.input（默认值 / transform 应用前，
 *   与 ipcRenderer.invoke 实际发送的字节一致）
 * - res：主进程 handler 返回的响应类型
 *
 * 由 InferRequestMap 从 definitions.ts 的定义表整体推导：新增 channel 自动进入映射，无需在此手写。
 */
export type IpcRequestMap = InferRequestMap<typeof IPC_DEFINITIONS>;

/**
 * 流式 / 事件 channel 的 payload 映射：channel → payload
 *
 * 两类 channel 都由主进程主动推送（webContents.send），渲染层经 subscribe 被动接收；
 * 订阅返回 unsubscribe，组件卸载必须调用，否则监听器泄漏：
 * - 流式：数据分片，如 agent:stream:part
 * - 事件：一次性状态变更，如 terminal:event:exit（终端退出）
 *
 * 消费时必须按 payload 携带的关联键（sessionId / terminalId / watcherId）过滤，避免跨会话污染。
 *
 * 由 InferEventMap 从 definitions.ts 的定义表整体推导，新增 channel 无需在此手写。
 */
export type IpcEventMap = InferEventMap<typeof IPC_DEFINITIONS>;
