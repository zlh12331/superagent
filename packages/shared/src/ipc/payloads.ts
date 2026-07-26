// packages/shared/src/ipc/payloads.ts
// IPC 请求/响应/事件 payload 类型映射
// 设计文档 §5.3 完整 Channel 清单
//
// 每个请求-响应 channel 定义 Req（请求入参）和 Res（响应数据）类型
// 流式/事件 channel 定义 Payload 类型
//
// P1 改造（Code Agent 架构）：
// - 新增 6 个域的 Req→Res 映射（agent/file/search/terminal/git/session）
// - 新增 6 个域的流式事件 payload 映射
// - 所有 Req 类型从 zod schema 派生（z.infer），schema 作为单一真源
// - Res / Payload 类型直接从 schema 文件 import（接口定义在 schema 文件中）
//
// 类型派生策略：
// - z.infer 派生 Req：z.object 入参自动获得字段类型与可选性
// - Res / Payload 接口：直接 import，避免重复定义
// - exactOptionalPropertyTypes 兼容：schema 用 `.optional().transform(v => v ?? undefined)`
//   让 z.infer 推断为 `string | undefined`，与显式 `| undefined` 类型对齐

import type { z } from 'zod';
import type {
  AgentApprovalRequestPayload,
  AgentApprovalResponseReqSchema,
  AgentRunReqSchema,
  AgentRunRes,
  AgentStopReqSchema,
  AgentStopRes,
  AgentStreamEndPayload,
  AgentStreamErrorPayload,
  AgentStreamPartPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
} from '../schemas/agent';
import type { ChatSendReqSchema, ChatStopReqSchema } from '../schemas/chat';
import type {
  CodebaseCalleesReqSchema,
  CodebaseCalleesRes,
  CodebaseCallersReqSchema,
  CodebaseCallersRes,
  CodebaseExploreReqSchema,
  CodebaseExploreRes,
  CodebaseImpactReqSchema,
  CodebaseImpactRes,
  CodebaseNodeReqSchema,
  CodebaseNodeRes,
  CodebaseQueryReqSchema,
  CodebaseQueryRes,
} from '../schemas/codebase';
import type { OpenDevToolsReq, OpenDevToolsRes } from '../schemas/devtools';
import type { DialogPickDirectoryReq, DialogPickDirectoryRes } from '../schemas/dialog';
import type {
  FileCreateDirReqSchema,
  FileCreateDirRes,
  FileCreateReqSchema,
  FileCreateRes,
  FileDeleteReqSchema,
  FileDeleteRes,
  FileListReqSchema,
  FileListRes,
  FileReadReqSchema,
  FileReadRes,
  FileRenameReqSchema,
  FileRenameRes,
  FileWatchEventPayload,
  FileWatchStartReqSchema,
  FileWatchStartRes,
  FileWatchStopReqSchema,
  FileWatchStopRes,
  FileWriteReqSchema,
  FileWriteRes,
} from '../schemas/file';
import type {
  GitAddReqSchema,
  GitAddRes,
  GitCommitReqSchema,
  GitCommitRes,
  GitDiffReqSchema,
  GitDiffRes,
  GitPushReqSchema,
  GitPushRes,
  GitStatusReqSchema,
  GitStatusRes,
} from '../schemas/git';
import type { GlobReqSchema, GlobRes, GrepReqSchema, GrepRes } from '../schemas/search';
import type {
  SessionCreateReqSchema,
  SessionCreateRes,
  SessionDeleteReqSchema,
  SessionDeleteRes,
  SessionGetReqSchema,
  SessionGetRes,
  SessionListRecentDirsReqSchema,
  SessionListRecentDirsRes,
  SessionListReqSchema,
  SessionListRes,
  SessionRenameReqSchema,
  SessionRenameRes,
} from '../schemas/session';
import type {
  DeleteApiKeyReqSchema,
  DeleteApiKeyRes,
  GetApiKeyReqSchema,
  GetApiKeyRes,
  GetTelemetryLevelRes,
  SetApiKeyReqSchema,
  SetApiKeyRes,
  SetTelemetryLevelReqSchema,
  SetTelemetryLevelRes,
} from '../schemas/settings';
import type { ReadLogsReq, ReadLogsRes, SystemStatusRes } from '../schemas/system';
import type {
  TerminalCreatedEventPayload,
  TerminalCreateReqSchema,
  TerminalCreateRes,
  TerminalExitEventPayload,
  TerminalInputReqSchema,
  TerminalInputRes,
  TerminalKillReqSchema,
  TerminalKillRes,
  TerminalOutputEventPayload,
  TerminalResizeReqSchema,
  TerminalResizeRes,
} from '../schemas/terminal';
import type { ToolListReqSchema, ToolListRes } from '../schemas/tool';

// 从 schemas/chat.ts 重新导出 ChatMessage 类型（= AI SDK 的 ModelMessage）
export type { ChatMessage } from '../schemas/chat';

// ─── 应用级 payload ─────────────────────────────────────────────

/**
 * 应用状态（health check）
 *
 * 说明：原 PG/Ollama/DB 状态字段已随数据库层删除，
 * 当前仅保留应用运行状态标记，便于渲染层做基本健康检查。
 */
export interface AppStatus {
  /** 应用是否已就绪（true 表示主进程初始化完成） */
  readonly ready: boolean;
}

// ─── Chat 域 payload（保留兼容，Vercel AI SDK v7） ─────────────

/**
 * chat:send 请求 payload
 *
 * 类型从 ChatSendReqSchema 派生（z.infer），schema 为单一真源。
 *
 * 消息列表由渲染层维护，每次发起对话把完整历史传给主进程，
 * 主进程不持有对话上下文（无状态设计，便于多窗口/多会话扩展）。
 *
 * P1-6 透传设计：messages 类型为 ChatMessage[]（= ModelMessage[]），
 * 渲染层用 convertToModelMessages 转换后直接透传，主进程无需手动转换。
 *
 * sessionId 使用 `string | undefined` 而非 `?: string`：
 * exactOptionalPropertyTypes 严格模式下，zod `.optional().transform()` 推断为 `string | undefined`，
 * 显式声明 `| undefined` 才能兼容 zod schema 推断的类型。
 */
export type ChatSendReq = z.infer<typeof ChatSendReqSchema>;

/** chat:send 响应 payload：返回本次对话的 sessionId */
export interface ChatSendRes {
  /** 本次对话的唯一标识，渲染层用此 id 订阅后续流式事件并支持中断 */
  readonly sessionId: string;
}

/** chat:stop 请求 payload：中断指定 sessionId 的对话 */
export type ChatStopReq = z.infer<typeof ChatStopReqSchema>;

/** chat:stop 响应 payload */
export interface ChatStopRes {
  /** 是否成功中断（若对话已结束则返回 false） */
  readonly stopped: boolean;
}

/**
 * chat:stream:part 事件 payload
 *
 * part 类型为 Vercel AI SDK 官方 UIMessageStreamPart 的 JSON 序列化形式。
 * 通过 IPC 传输时使用 unknown 而非具体类型，避免 shared 包依赖 ai 包
 * （shared 包应保持零运行时依赖，仅暴露类型契约）。
 *
 * 渲染层在 IpcChatTransport 中把 unknown 重新喂给 useChat 的 ReadableStream。
 */
export interface ChatStreamPartPayload {
  /** 本次对话的 sessionId，渲染层按 id 过滤事件 */
  readonly sessionId: string;
  /**
   * UIMessageStreamPart 的 JSON 序列化对象。
   * 主进程从 toUIMessageStream() 读出后原样转发，渲染层直接 enqueue。
   */
  readonly part: unknown;
}

/** chat:stream:end 事件 payload：流正常结束 */
export interface ChatStreamEndPayload {
  /** 本次对话的 sessionId */
  readonly sessionId: string;
}

/** chat:stream:error 事件 payload：流异常结束 */
export interface ChatStreamErrorPayload {
  /** 本次对话的 sessionId */
  readonly sessionId: string;
  /** 错误码（与 AppError.code 对齐） */
  readonly code: string;
  /** 错误消息（人类可读，用于渲染层 toast） */
  readonly message: string;
}

// ─── Agent 域 Req 派生（Code Agent 核心） ─────────────────────

/** agent:run 请求 payload：发起一次 agent 对话 */
export type AgentRunReq = z.infer<typeof AgentRunReqSchema>;

/** agent:stop 请求 payload：中断指定 sessionId 的 agent 对话 */
export type AgentStopReq = z.infer<typeof AgentStopReqSchema>;

/** agent:approval:response 请求 payload：渲染层回传审批结果 */
export type AgentApprovalResponseReq = z.infer<typeof AgentApprovalResponseReqSchema>;

// ─── File 域 Req 派生（文件读写） ──────────────────────────────

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

// ─── Search 域 Req 派生（ripgrep + glob） ──────────────────────

/** search:grep 请求 payload：正则搜索文件内容 */
export type GrepReq = z.infer<typeof GrepReqSchema>;

/** search:glob 请求 payload：glob 模式匹配文件路径 */
export type GlobReq = z.infer<typeof GlobReqSchema>;

// ─── Terminal 域 Req 派生（node-pty 会话池） ───────────────────

/** terminal:create 请求 payload：创建终端会话 */
export type TerminalCreateReq = z.infer<typeof TerminalCreateReqSchema>;

/** terminal:input 请求 payload：向终端写入输入 */
export type TerminalInputReq = z.infer<typeof TerminalInputReqSchema>;

/** terminal:resize 请求 payload：调整终端尺寸 */
export type TerminalResizeReq = z.infer<typeof TerminalResizeReqSchema>;

/** terminal:kill 请求 payload：终止终端会话 */
export type TerminalKillReq = z.infer<typeof TerminalKillReqSchema>;

// ─── Git 域 Req 派生（Git CLI 封装） ────────────────────────────

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

// ─── Codebase 域 Req 派生（codegraph CLI 封装） ────────────────

/** codebase:query 请求 payload：结构化符号搜索 */
export type CodebaseQueryReq = z.infer<typeof CodebaseQueryReqSchema>;

/** codebase:explore 请求 payload：区域探索（自然语言查询） */
export type CodebaseExploreReq = z.infer<typeof CodebaseExploreReqSchema>;

/** codebase:node 请求 payload：符号详情或文件内容 */
export type CodebaseNodeReq = z.infer<typeof CodebaseNodeReqSchema>;

/** codebase:callers 请求 payload：调用方查询 */
export type CodebaseCallersReq = z.infer<typeof CodebaseCallersReqSchema>;

/** codebase:callees 请求 payload：被调用方查询 */
export type CodebaseCalleesReq = z.infer<typeof CodebaseCalleesReqSchema>;

/** codebase:impact 请求 payload：影响分析 */
export type CodebaseImpactReq = z.infer<typeof CodebaseImpactReqSchema>;

// ─── Session 域 Req 派生（SQLite 持久化） ──────────────────────

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

// ─── Dialog 域 Req 派生（原生对话框） ─────────────────────────
// DialogPickDirectoryReq 直接从 schemas/dialog.ts 导入（schema 文件已导出 z.infer 类型）
// DialogPickDirectoryReqSchema 供 main 进程 dialog.handler.ts 用于运行时校验入参

// ─── Tool 域 Req 派生（工具系统元数据） ─────────────────────

/** tool:list 请求 payload：列出已注册工具清单（可按权限过滤） */
export type ToolListReq = z.infer<typeof ToolListReqSchema>;

// ─── Settings 域 Req 派生（API Key 管理） ─────────────────────

/** settings:getApiKey 请求 payload：查询指定提供商的 API Key */
export type GetApiKeyReq = z.infer<typeof GetApiKeyReqSchema>;

/** settings:setApiKey 请求 payload：设置 API Key */
export type SetApiKeyReq = z.infer<typeof SetApiKeyReqSchema>;

/** settings:deleteApiKey 请求 payload：删除指定提供商的 API Key */
export type DeleteApiKeyReq = z.infer<typeof DeleteApiKeyReqSchema>;

/** settings:setTelemetryLevel 请求 payload：设置遥测级别 */
export type SetTelemetryLevelReq = z.infer<typeof SetTelemetryLevelReqSchema>;

// 重新导出非 z.infer 类型（接口/联合）
export type {
  GetTelemetryLevelRes,
  SetTelemetryLevelRes,
  TelemetryLevel,
} from '../schemas/settings';
export { SetTelemetryLevelReqSchema, TelemetryLevelSchema } from '../schemas/settings';

// ─── System 域（运行时可观测性） ──────────────────────────────
// ReadLogsReq 直接从 schemas/system.ts 导入（schema 文件已导出 z.infer 类型）
// ReadLogsReqSchema 供 main 进程 system.handler.ts 用于运行时校验入参

// ─── DevTools 域 Req 派生（开发者工具集成） ───────────────────
// OpenDevToolsReq / OpenDevToolsReqSchema / OpenDevToolsRes 直接从 schemas/devtools.ts 导入
// main 进程 devtools.handler.ts 使用 OpenDevToolsReqSchema 做运行时校验
export type { OpenDevToolsReq, OpenDevToolsRes } from '../schemas/devtools';
export { OpenDevToolsReqSchema } from '../schemas/devtools';

// ─── IPC 类型映射 ─────────────────────────────────────────────

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
 * 类型完整性：所有在 channels.ts 中定义的请求-响应 channel 必须在此映射中存在，
 * 否则 IpcApi 的 invoke 方法类型推断会失败。
 */
export interface IpcRequestMap {
  // 应用级
  'app:getStatus': { req: void; res: AppStatus };
  'app:openExternal': { req: { url: string }; res: { ok: boolean } };

  // 聊天域（Vercel AI SDK v7，单轮流式响应，保留兼容）
  'chat:send': { req: ChatSendReq; res: ChatSendRes };
  'chat:stop': { req: ChatStopReq; res: ChatStopRes };

  // Agent 域（Code Agent 核心，多轮工具调用）
  // agent:run 发起对话，返回 sessionId；后续通过 agent:stream:* / agent:tool:* / agent:approval:* 推送事件
  'agent:run': { req: AgentRunReq; res: AgentRunRes };
  'agent:stop': { req: AgentStopReq; res: AgentStopRes };
  // agent:approval:response 是审批回传通道（请求-响应模式）
  // 主进程收到 response 后 resolve 对应 approvalId 的 Promise，ToolExecutor 继续/中止执行
  'agent:approval:response': {
    req: AgentApprovalResponseReq;
    res: { ok: boolean };
  };

  // 文件域（文件读写 + 目录列表 + 文件监听）
  'file:read': { req: FileReadReq; res: FileReadRes };
  'file:write': { req: FileWriteReq; res: FileWriteRes };
  'file:list': { req: FileListReq; res: FileListRes };
  // file:watch:start 发起监听，返回 watcherId；后续通过 file:watch:event 推送变更
  'file:watch:start': { req: FileWatchStartReq; res: FileWatchStartRes };
  // file:watch:stop 停止指定 watcher
  'file:watch:stop': { req: FileWatchStopReq; res: FileWatchStopRes };
  // 文件树编辑操作（新建/删除/重命名）
  'file:create': { req: FileCreateReq; res: FileCreateRes };
  'file:createDir': { req: FileCreateDirReq; res: FileCreateDirRes };
  'file:delete': { req: FileDeleteReq; res: FileDeleteRes };
  'file:rename': { req: FileRenameReq; res: FileRenameRes };

  // 搜索域（ripgrep + glob）
  'search:grep': { req: GrepReq; res: GrepRes };
  'search:glob': { req: GlobReq; res: GlobRes };

  // 终端域（node-pty 会话池）
  'terminal:create': { req: TerminalCreateReq; res: TerminalCreateRes };
  'terminal:input': { req: TerminalInputReq; res: TerminalInputRes };
  'terminal:resize': { req: TerminalResizeReq; res: TerminalResizeRes };
  'terminal:kill': { req: TerminalKillReq; res: TerminalKillRes };

  // Git 域（Git CLI 封装）
  'git:status': { req: GitStatusReq; res: GitStatusRes };
  'git:diff': { req: GitDiffReq; res: GitDiffRes };
  'git:add': { req: GitAddReq; res: GitAddRes };
  'git:commit': { req: GitCommitReq; res: GitCommitRes };
  'git:push': { req: GitPushReq; res: GitPushRes };

  // 代码库域（codegraph CLI 封装，代码智能查询）
  'codebase:query': { req: CodebaseQueryReq; res: CodebaseQueryRes };
  'codebase:explore': { req: CodebaseExploreReq; res: CodebaseExploreRes };
  'codebase:node': { req: CodebaseNodeReq; res: CodebaseNodeRes };
  'codebase:callers': { req: CodebaseCallersReq; res: CodebaseCallersRes };
  'codebase:callees': { req: CodebaseCalleesReq; res: CodebaseCalleesRes };
  'codebase:impact': { req: CodebaseImpactReq; res: CodebaseImpactRes };

  // 会话域（SQLite 持久化）
  'session:list': { req: SessionListReq; res: SessionListRes };
  'session:get': { req: SessionGetReq; res: SessionGetRes };
  'session:delete': { req: SessionDeleteReq; res: SessionDeleteRes };
  'session:rename': { req: SessionRenameReq; res: SessionRenameRes };
  // 会话域 — 创建 + 最近目录
  'session:create': { req: SessionCreateReq; res: SessionCreateRes };
  'session:listRecentDirs': { req: SessionListRecentDirsReq; res: SessionListRecentDirsRes };

  // 工具域（工具系统元数据查询）
  // tool:list 列出当前已注册的工具清单（含权限级别，供渲染层展示工具面板）
  'tool:list': { req: ToolListReq; res: ToolListRes };

  // Settings 域（API Key / 敏感数据管理 / 遥测级别）
  // settings:getApiKey 返回明文或 null，settings:setApiKey 加密后存储，settings:deleteApiKey 删除
  'settings:getApiKey': { req: GetApiKeyReq; res: GetApiKeyRes };
  'settings:setApiKey': { req: SetApiKeyReq; res: SetApiKeyRes };
  'settings:deleteApiKey': { req: DeleteApiKeyReq; res: DeleteApiKeyRes };
  // settings:getTelemetryLevel 查询遥测级别，settings:setTelemetryLevel 修改（需重启生效）
  'settings:getTelemetryLevel': { req: void; res: GetTelemetryLevelRes };
  'settings:setTelemetryLevel': { req: SetTelemetryLevelReq; res: SetTelemetryLevelRes };

  // System 域（运行时可观测性，DevPanel 使用）
  // system:getStatus 返回运行时状态（内存/CPU/uptime/版本），无入参
  // logs:read 读取最近 N 行日志（从 main.log 文件尾部倒读），入参全可选
  'system:getStatus': { req: void; res: SystemStatusRes };
  'logs:read': { req: ReadLogsReq; res: ReadLogsRes };

  // DevTools 域（开发者工具集成，DevPanel Inspector tab 使用）
  // devtools:open 打开 Chromium DevTools，入参 { mode? } 默认 detach 独立窗口
  'devtools:open': { req: OpenDevToolsReq; res: OpenDevToolsRes };

  // Dialog 域（原生目录选择器）
  'dialog:pickDirectory': { req: DialogPickDirectoryReq; res: DialogPickDirectoryRes };
}

/**
 * 流式/事件 channel payload 映射
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
export interface IpcEventMap {
  // ── Chat 域流式事件（保留兼容） ───────────────────
  // 主进程逐 part 推送 UIMessageStreamPart
  'chat:stream:part': ChatStreamPartPayload;
  // 聊天流正常结束
  'chat:stream:end': ChatStreamEndPayload;
  // 聊天流异常结束
  'chat:stream:error': ChatStreamErrorPayload;

  // ── Agent 域流式事件（Code Agent 核心） ────────────
  // 主进程逐 part 推送 UIMessageStreamPart（text/tool-call/tool-result/finish 等）
  'agent:stream:part': AgentStreamPartPayload;
  // agent 对话结束（含原因：completed/aborted/error）
  'agent:stream:end': AgentStreamEndPayload;
  // agent 对话异常结束（错误码 + 消息）
  'agent:stream:error': AgentStreamErrorPayload;
  // 工具调用事件：主进程推送工具调用详情，渲染层展示 UI
  'agent:tool:call': AgentToolCallPayload;
  // 工具执行结果事件：主进程推送工具执行结果（含 output 或 error）
  'agent:tool:result': AgentToolResultPayload;
  // 审批请求事件：主进程请求用户审批（permission='ask' 的工具调用）
  // 渲染层弹出 ApprovalModal，用户选择后通过 agent:approval:response 回传结果
  'agent:approval:request': AgentApprovalRequestPayload;

  // ── 文件域事件（chokidar 监听） ───────────────────
  // 文件系统变更事件：create/modify/delete/rename（携带 watcherId 关联）
  'file:watch:event': FileWatchEventPayload;

  // ── 终端域事件（node-pty 输出与退出） ──────────────
  // 终端创建成功（通知渲染层有新终端，包括 Agent 工具创建的）
  'terminal:event:created': TerminalCreatedEventPayload;
  // 终端原始输出（含 ANSI 转义序列，未解码，渲染层用 xterm.js 直接 write）
  'terminal:event:output': TerminalOutputEventPayload;
  // 终端进程退出（exitCode 0 正常退出，非 0 异常退出）
  'terminal:event:exit': TerminalExitEventPayload;
}
