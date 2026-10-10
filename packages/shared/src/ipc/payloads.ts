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

export type { ChatMessage } from '../schemas/chat';

/**
 * 应用状态（health check）
 *
 * 说明：原 PG/Ollama/DB 状态字段已随数据库层删除，
 * 当前仅保留应用运行状态标记，便于渲染层做基本健康检查。
 */
export interface AppStatus {
  /** 应用是否已就绪（true 表示主进程初始化完成） */
  readonly ready: boolean;
  /**
   * IPC 协议版本（渲染层启动时校验；不匹配 = 主进程/渲染层来自不同构建，提示重启）
   *
   * 与 IPC_PROTOCOL_VERSION（constants/protocol.ts）比较。
   */
  readonly protocolVersion: number;
}

/** agent:run 请求 payload：发起一次 agent 对话 */
export type AgentRunReq = z.infer<typeof AgentRunReqSchema>;

/** agent:stop 请求 payload：中断指定 sessionId 的 agent 对话 */
export type AgentStopReq = z.infer<typeof AgentStopReqSchema>;

/** agent:approval:response 请求 payload：渲染层回传审批结果 */
export type AgentApprovalResponseReq = z.infer<typeof AgentApprovalResponseReqSchema>;

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

/** search:grep 请求 payload：正则搜索文件内容 */
export type GrepReq = z.infer<typeof GrepReqSchema>;

/** search:glob 请求 payload：glob 模式匹配文件路径 */
export type GlobReq = z.infer<typeof GlobReqSchema>;

/** terminal:create 请求 payload：创建终端会话 */
export type TerminalCreateReq = z.infer<typeof TerminalCreateReqSchema>;

/** terminal:input 请求 payload：向终端写入输入 */
export type TerminalInputReq = z.infer<typeof TerminalInputReqSchema>;

/** terminal:resize 请求 payload：调整终端尺寸 */
export type TerminalResizeReq = z.infer<typeof TerminalResizeReqSchema>;

/** terminal:kill 请求 payload：终止终端会话 */
export type TerminalKillReq = z.infer<typeof TerminalKillReqSchema>;

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

/** tool:list 请求 payload：列出已注册工具清单（可按权限过滤） */
export type ToolListReq = z.infer<typeof ToolListReqSchema>;

/** settings:getApiKey 请求 payload：查询指定提供商的 API Key */
export type GetApiKeyReq = z.infer<typeof GetApiKeyReqSchema>;

/** settings:setApiKey 请求 payload：设置 API Key */
export type SetApiKeyReq = z.infer<typeof SetApiKeyReqSchema>;

/** settings:deleteApiKey 请求 payload：删除指定提供商的 API Key */
export type DeleteApiKeyReq = z.infer<typeof DeleteApiKeyReqSchema>;

/** settings:setTelemetryLevel 请求 payload：设置遥测级别 */
export type SetTelemetryLevelReq = z.infer<typeof SetTelemetryLevelReqSchema>;

export type { OpenDevToolsReq, OpenDevToolsRes } from '../schemas/devtools';
export { OpenDevToolsReqSchema } from '../schemas/devtools';
export type {
  GetTelemetryLevelRes,
  SetTelemetryLevelRes,
  TelemetryLevel,
} from '../schemas/settings';
export { SetTelemetryLevelReqSchema, TelemetryLevelSchema } from '../schemas/settings';

/**
 * 请求-响应 channel 类型映射：Req → Res
 *
 * 每个 channel 定义 req 与 res 两个字段：
 * - req：渲染层 invoke 时传入的入参类型
 * - res：主进程 handle 返回的响应数据类型
 *
 * 渲染层通过 ipcRenderer.invoke(channel, req) 调用，
 * 主进程通过 ipcMain.handle(channel, (e, req: Req) => Res) 注册 handler。
 *
 * 类型完整性：所有在 definitions.ts 中定义的请求-响应 channel 自动进入此映射，
 * 无需手写（由 InferRequestMap 推导）。
 */
export type IpcRequestMap = InferRequestMap<typeof IPC_DEFINITIONS>;

/**
 * 流式/事件 channel payload 映射（从 IPC_DEFINITIONS 自动推导）
 *
 * 流式 channel 由主进程主动 webContents.send 推送，渲染层通过 ipcRenderer.on 订阅。
 * 事件 channel 同样由主进程推送，但表示一次性状态变更（如终端退出）。
 *
 * 与请求-响应 channel 的区别：
 * - 请求-响应：渲染层主动 invoke，主进程返回结果（同步等待）
 * - 流式/事件：主进程主动推送，渲染层被动接收（异步观察）
 *
 * 渲染层订阅后必须按 sessionId / terminalId 过滤事件，避免跨会话污染。
 */
export type IpcEventMap = InferEventMap<typeof IPC_DEFINITIONS>;
