// packages/shared/src/ipc/definitions.ts
// IPC 定义表：在 IPC_META 基础上合并 zod schema 与类型标记（完整单一真源）
// ──────────────────────────────────────────────────────────────
// 设计：
// - channel + kind 来自 IPC_META（纯字符串，preload 沙箱安全）
// - 本文件追加 schema（入参校验）与 res/payload 类型标记
// - 从本表推导：IpcApi（api.ts）、IpcRequestMap/IpcEventMap（payloads.ts）
// - preload 生成器消费 IPC_META，主进程注册表消费本文件
//
// 依赖方向：meta（零依赖）← definitions（+schema）← payloads/api（类型推导）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

import {
  type AgentApprovalRequestPayload,
  AgentApprovalRequestPayloadSchema,
  AgentApprovalResponseReqSchema,
  AgentRunReqSchema,
  type AgentRunRes,
  AgentRunResSchema,
  AgentStopReqSchema,
  type AgentStopRes,
  AgentStopResSchema,
  type AgentStreamEndPayload,
  type AgentStreamErrorPayload,
  type AgentStreamPartPayload,
  type AgentToolCallPayload,
  type AgentToolResultPayload,
} from '../schemas/agent';
import {
  type AskEventPayload,
  AskEventPayloadSchema,
  AskRespondReqSchema,
  type AskRespondRes,
  AskRespondResSchema,
} from '../schemas/agent-ask';
import type { TurnEvent } from '../schemas/agent-events';
import type { AppInfoRes } from '../schemas/app';
import { AppInfoResSchema, AppStatusResSchema } from '../schemas/app';
import {
  ChatSendReqSchema,
  ChatSendResSchema,
  ChatStopReqSchema,
  ChatStopResSchema,
} from '../schemas/chat';
import {
  CodebaseCalleesReqSchema,
  type CodebaseCalleesRes,
  CodebaseCallersReqSchema,
  type CodebaseCallersRes,
  CodebaseExploreReqSchema,
  type CodebaseExploreRes,
  CodebaseImpactReqSchema,
  type CodebaseImpactRes,
  CodebaseMarkdownResSchema,
  CodebaseNodeReqSchema,
  type CodebaseNodeRes,
  CodebaseQueryReqSchema,
  type CodebaseQueryRes,
  CodebaseQueryResSchema,
} from '../schemas/codebase';
import {
  OpenDevToolsReqSchema,
  type OpenDevToolsRes,
  OpenDevToolsResSchema,
} from '../schemas/devtools';
import {
  DialogPickDirectoryReqSchema,
  type DialogPickDirectoryRes,
  DialogPickDirectoryResSchema,
  DialogPickFilesReqSchema,
  type DialogPickFilesRes,
  DialogPickFilesResSchema,
} from '../schemas/dialog';
import {
  FileCreateDirReqSchema,
  type FileCreateDirRes,
  FileCreateDirResSchema,
  FileCreateReqSchema,
  type FileCreateRes,
  FileCreateResSchema,
  FileDeleteReqSchema,
  type FileDeleteRes,
  FileDeleteResSchema,
  FileListReqSchema,
  type FileListRes,
  FileListResSchema,
  FileReadReqSchema,
  type FileReadRes,
  FileReadResSchema,
  FileRenameReqSchema,
  type FileRenameRes,
  FileRenameResSchema,
  type FileWatchEventPayload,
  FileWatchEventPayloadSchema,
  FileWatchStartReqSchema,
  type FileWatchStartRes,
  FileWatchStartResSchema,
  FileWatchStopReqSchema,
  type FileWatchStopRes,
  FileWatchStopResSchema,
  FileWriteReqSchema,
  type FileWriteRes,
  FileWriteResSchema,
} from '../schemas/file';
import {
  GitAddReqSchema,
  type GitAddRes,
  GitAddResSchema,
  GitCommitReqSchema,
  type GitCommitRes,
  GitCommitResSchema,
  GitDiffReqSchema,
  type GitDiffRes,
  GitDiffResSchema,
  GitPushReqSchema,
  type GitPushRes,
  GitPushResSchema,
  GitStatusReqSchema,
  type GitStatusRes,
  GitStatusResSchema,
} from '../schemas/git';
import {
  GoalClearReqSchema,
  type GoalClearRes,
  GoalClearResSchema,
  GoalCreateReqSchema,
  type GoalCreateRes,
  GoalListReqSchema,
  type GoalListRes,
  GoalListResSchema,
} from '../schemas/goal';
import type { ChannelListRes, ChannelOpRes } from '../schemas/im';
import { ChannelListResSchema, ChannelStartReqSchema, ChannelStopReqSchema } from '../schemas/im';
import {
  McpListReqSchema,
  type McpListRes,
  McpListResSchema,
  McpServerConfigSchema,
  type McpStartRes,
  McpStopReqSchema,
  type McpStopRes,
} from '../schemas/mcp';
import {
  MemoryClearReqSchema,
  type MemoryClearRes,
  MemoryClearResSchema,
  MemoryListReqSchema,
  type MemoryListRes,
  MemoryListResSchema,
} from '../schemas/memory';
import {
  type ModelsListRes,
  ModelsListResSchema,
  TestModelReqSchema,
  type TestModelRes,
  TestModelResSchema,
} from '../schemas/models';
import {
  GlobReqSchema,
  type GlobRes,
  GlobResSchema,
  GrepReqSchema,
  type GrepRes,
  GrepResSchema,
} from '../schemas/search';
import {
  SessionCompactReqSchema,
  type SessionCompactRes,
  SessionCompactResSchema,
  SessionCreateReqSchema,
  type SessionCreateRes,
  SessionCreateResSchema,
  SessionDeleteReqSchema,
  type SessionDeleteRes,
  SessionDeleteResSchema,
  SessionGetRecentTurnsReqSchema,
  SessionGetReqSchema,
  type SessionGetRes,
  SessionGetResSchema,
  SessionGetTurnMessagesReqSchema,
  type SessionGetTurnMessagesRes,
  SessionGetTurnMessagesResSchema,
  SessionGetTurnsReqSchema,
  type SessionGetTurnsRes,
  SessionGetTurnsResSchema,
  SessionListRecentDirsReqSchema,
  type SessionListRecentDirsRes,
  SessionListRecentDirsResSchema,
  SessionListReqSchema,
  type SessionListRes,
  SessionListResSchema,
  SessionPinReqSchema,
  type SessionPinRes,
  SessionPinResSchema,
  type SessionRecentTurnsRes,
  SessionRecentTurnsResSchema,
  SessionRenameReqSchema,
  type SessionRenameRes,
  SessionRenameResSchema,
  type UsageSummaryRes,
  UsageSummaryResSchema,
} from '../schemas/session';
import {
  AddRuntimeModelReqSchema,
  type AddRuntimeModelRes,
  AddRuntimeModelResSchema,
  DeleteApiKeyReqSchema,
  type DeleteApiKeyRes,
  DeleteApiKeyResSchema,
  GetApiKeyReqSchema,
  type GetApiKeyRes,
  GetApiKeyResSchema,
  type GetApprovalModeRes,
  GetApprovalModeResSchema,
  type GetTelemetryLevelRes,
  GetTelemetryLevelResSchema,
  type ListRuntimeModelsRes,
  ListRuntimeModelsResSchema,
  RemoveRuntimeModelReqSchema,
  type RemoveRuntimeModelRes,
  RemoveRuntimeModelResSchema,
  SetApiKeyReqSchema,
  type SetApiKeyRes,
  SetApiKeyResSchema,
  SetApprovalModeReqSchema,
  type SetApprovalModeRes,
  SetApprovalModeResSchema,
  SetTelemetryLevelReqSchema,
  type SetTelemetryLevelRes,
  SetTelemetryLevelResSchema,
  SettingsGetAllReqSchema,
  SettingsGetAllResSchema,
  SettingsSetReqSchema,
  SettingsSetResSchema,
  UpdateRuntimeModelReqSchema,
  type UpdateRuntimeModelRes,
  UpdateRuntimeModelResSchema,
} from '../schemas/settings';
import {
  SkillLearnReqSchema,
  SkillLearnResSchema,
  SkillListLearnedResSchema,
  type SkillListRes,
  SkillListResSchema,
  SkillRemoveLearnedResSchema,
  SkillRemoveReqSchema,
} from '../schemas/skill';
import {
  ReadLogsReqSchema,
  type ReadLogsRes,
  ReadLogsResSchema,
  type SystemStatusRes,
  SystemStatusResSchema,
} from '../schemas/system';
import { TaskListReqSchema, type TaskListRes, TaskListResSchema } from '../schemas/task';
import {
  type TerminalCreatedEventPayload,
  TerminalCreatedEventPayloadSchema,
  TerminalCreateReqSchema,
  type TerminalCreateRes,
  TerminalCreateResSchema,
  type TerminalExitEventPayload,
  TerminalExitEventPayloadSchema,
  TerminalInputReqSchema,
  type TerminalInputRes,
  TerminalInputResSchema,
  TerminalKillReqSchema,
  type TerminalKillRes,
  TerminalKillResSchema,
  type TerminalOutputEventPayload,
  TerminalOutputEventPayloadSchema,
  TerminalResizeReqSchema,
  type TerminalResizeRes,
  TerminalResizeResSchema,
} from '../schemas/terminal';
import { ToolListReqSchema, type ToolListRes, ToolListResSchema } from '../schemas/tool';
import {
  UpdateCheckReqSchema,
  type UpdateCheckRes,
  UpdateCheckResSchema,
  type UpdateStatusPayload,
  UpdateStatusPayloadSchema,
} from '../schemas/update';
import {
  OkResSchema,
  WhitelistAddReqSchema,
  type WhitelistAddRes,
  type WhitelistListRes,
  WhitelistListResSchema,
  WhitelistRemoveReqSchema,
  type WhitelistRemoveRes,
} from '../schemas/whitelist';
import { IPC_META, type IpcMeta } from './meta';

/**
 * 在元数据基础上合并 schema 与响应类型标记（request 方法）
 *
 * @param meta 来自 IPC_META 的 request 条目
 * @param schema 入参 zod schema（null 表示无入参）
 * @param _res 响应类型标记（仅编译期类型用途，运行时忽略；下划线 = 未使用参数）
 */
export function withSchema<
  M extends { readonly kind: 'request'; readonly channel: string },
  S extends z.ZodType | null,
  R,
  // biome-ignore lint/style/useNamingConvention: RS 为 TS 泛型惯例（响应 schema 类型参数）
  RS extends z.ZodType | undefined = undefined,
>(
  meta: M,
  schema: S,
  _res: R,
  resSchema?: RS,
): M & { readonly schema: S; readonly res: R; readonly resSchema?: RS } {
  return {
    ...meta,
    schema,
    res: undefined as unknown as R,
    // 条件展开：resSchema 为 undefined 时不携带字段（exactOptionalPropertyTypes）
    ...(resSchema !== undefined ? { resSchema } : {}),
  } as M & { readonly schema: S; readonly res: R; readonly resSchema?: RS };
}

/**
 * 在元数据基础上合并事件 payload 类型标记（event 方法）
 *
 * @param meta 来自 IPC_META 的 event 条目
 * @param _payload payload 类型标记（仅编译期类型用途，运行时忽略；下划线 = 未使用参数）
 * @param payloadSchema 事件 payload 的 zod schema（可选；主进程发送侧 dev 校验用）
 */
export function withPayload<
  M extends { readonly kind: 'event'; readonly channel: string },
  P,
  // biome-ignore lint/style/useNamingConvention: PS 为 TS 泛型惯例（payload schema 类型参数）
  PS extends z.ZodType | undefined = undefined,
>(
  meta: M,
  _payload: P,
  payloadSchema?: PS,
): M & { readonly payload: P; readonly payloadSchema?: PS } {
  return {
    ...meta,
    payload: undefined as unknown as P,
    ...(payloadSchema !== undefined ? { payloadSchema } : {}),
  } as M & { readonly payload: P; readonly payloadSchema?: PS };
}

/**
 * IPC 定义表（完整：channel + schema + 类型）
 *
 * 新增方法：在 IPC_META 加一行，再在本文件用 withSchema/withPayload 合并 schema。
 * preload 生成器自动同步（消费 IPC_META），handler 缺失在编译期报错（InferHandlers）。
 */
const AudioStartReqSchema = z.object({
  sampleRate: z.number().int().positive().max(48000).optional(),
  channels: z.number().int().positive().max(2).optional(),
});
const AudioAppendReqSchema = z.object({
  sessionId: z.string(),
  chunk: z.instanceof(Uint8Array),
});
const AudioStopReqSchema = z.object({
  sessionId: z.string(),
});

// ─── 事件 payload zod schema（主进程发送侧 dev 校验，envelope 级） ───

/** agent:stream:part / chat:stream:part 事件 envelope（part 为 SDK 结构，仅校验 sessionId） */
const StreamPartPayloadSchema = z.object({
  sessionId: z.string().min(1),
  part: z.unknown(),
});

/** chat:stream:end 事件 payload schema */
const ChatStreamEndPayloadSchema = z.object({
  sessionId: z.string().min(1),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** chat:stream:error / agent:stream:error 事件 payload schema */
const StreamErrorPayloadSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});

/** agent:stream:end 事件 payload schema */
const AgentStreamEndPayloadSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(['completed', 'aborted', 'error']),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** agent:tool:call 事件 payload schema（input 为工具入参，仅 envelope 校验） */
const AgentToolCallPayloadSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  permission: z.enum(['auto', 'ask', 'deny']),
  input: z.unknown(),
});

/** agent:tool:result 事件 payload schema（output/metadata 结构由工具决定，仅 envelope 校验） */
const AgentToolResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  title: z.string().min(1),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});

/** audio:start 响应 schema（R4：响应契约校验） */
const AudioStartResSchema = z.object({
  sessionId: z.string().min(1),
});

/** audio:append 响应 schema（R4：响应契约校验） */
const AudioAppendResSchema = z.object({
  received: z.number().int().nonnegative(),
});

/** audio:stop 响应 schema（R4：响应契约校验） */
const AudioStopResSchema = z.object({
  path: z.string(),
  durationMs: z.number().int().nonnegative(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  byteLength: z.number().int().nonnegative(),
});

export const IPC_DEFINITIONS = {
  audio: {
    start: withSchema(
      IPC_META.audio.start,
      AudioStartReqSchema,
      {} as { sessionId: string },
      AudioStartResSchema,
    ),
    append: withSchema(
      IPC_META.audio.append,
      AudioAppendReqSchema,
      {} as { received: number },
      AudioAppendResSchema,
    ),
    stop: withSchema(
      IPC_META.audio.stop,
      AudioStopReqSchema,
      {} as {
        path: string;
        durationMs: number;
        sampleRate: number;
        channels: number;
        byteLength: number;
      },
      AudioStopResSchema,
    ),
  },

  app: {
    getStatus: withSchema(
      IPC_META.app.getStatus,
      null,
      {} as { ready: boolean; protocolVersion: number },
      AppStatusResSchema,
    ),
    getInfo: withSchema(IPC_META.app.getInfo, null, {} as AppInfoRes, AppInfoResSchema),
    openExternal: withSchema(
      IPC_META.app.openExternal,
      z.object({ url: z.string().min(1, 'URL 不能为空') }),
      {} as { ok: boolean },
      OkResSchema,
    ),
    openDataDir: withSchema(IPC_META.app.openDataDir, null, {} as { ok: boolean }, OkResSchema),
  },

  chat: {
    send: withSchema(
      IPC_META.chat.send,
      ChatSendReqSchema,
      {} as { sessionId: string },
      ChatSendResSchema,
    ),
    stop: withSchema(
      IPC_META.chat.stop,
      ChatStopReqSchema,
      {} as { stopped: boolean },
      ChatStopResSchema,
    ),
    subscribePart: withPayload(
      IPC_META.chat.subscribePart,
      {} as AgentStreamPartPayload,
      StreamPartPayloadSchema,
    ),
    subscribeEnd: withPayload(
      IPC_META.chat.subscribeEnd,
      {} as AgentStreamEndPayload,
      ChatStreamEndPayloadSchema,
    ),
    subscribeError: withPayload(
      IPC_META.chat.subscribeError,
      {} as AgentStreamErrorPayload,
      StreamErrorPayloadSchema,
    ),
  },

  agent: {
    run: withSchema(IPC_META.agent.run, AgentRunReqSchema, {} as AgentRunRes, AgentRunResSchema),
    stop: withSchema(
      IPC_META.agent.stop,
      AgentStopReqSchema,
      {} as AgentStopRes,
      AgentStopResSchema,
    ),
    respondAsk: withSchema(
      IPC_META.agent.respondAsk,
      AskRespondReqSchema,
      {} as AskRespondRes,
      AskRespondResSchema,
    ),
    approvalResponse: withSchema(
      IPC_META.agent.approvalResponse,
      AgentApprovalResponseReqSchema,
      {} as { ok: boolean },
      OkResSchema,
    ),
    subscribeStreamPart: withPayload(
      IPC_META.agent.subscribeStreamPart,
      {} as AgentStreamPartPayload,
      StreamPartPayloadSchema,
    ),
    subscribeAsk: withPayload(
      IPC_META.agent.subscribeAsk,
      {} as AskEventPayload,
      AskEventPayloadSchema,
    ),
    subscribeStreamEnd: withPayload(
      IPC_META.agent.subscribeStreamEnd,
      {} as AgentStreamEndPayload,
      AgentStreamEndPayloadSchema,
    ),
    subscribeStreamError: withPayload(
      IPC_META.agent.subscribeStreamError,
      {} as AgentStreamErrorPayload,
      StreamErrorPayloadSchema,
    ),
    subscribeToolCall: withPayload(
      IPC_META.agent.subscribeToolCall,
      {} as AgentToolCallPayload,
      AgentToolCallPayloadSchema,
    ),
    subscribeToolResult: withPayload(
      IPC_META.agent.subscribeToolResult,
      {} as AgentToolResultPayload,
      AgentToolResultPayloadSchema,
    ),
    subscribeApprovalRequest: withPayload(
      IPC_META.agent.subscribeApprovalRequest,
      {} as AgentApprovalRequestPayload,
      AgentApprovalRequestPayloadSchema,
    ),
    subscribeTurnEvent: withPayload(IPC_META.agent.subscribeTurnEvent, {} as TurnEvent),
  },

  session: {
    list: withSchema(
      IPC_META.session.list,
      SessionListReqSchema,
      {} as SessionListRes,
      SessionListResSchema,
    ),
    get: withSchema(
      IPC_META.session.get,
      SessionGetReqSchema,
      {} as SessionGetRes,
      SessionGetResSchema,
    ),
    delete: withSchema(
      IPC_META.session.delete,
      SessionDeleteReqSchema,
      {} as SessionDeleteRes,
      SessionDeleteResSchema,
    ),
    rename: withSchema(
      IPC_META.session.rename,
      SessionRenameReqSchema,
      {} as SessionRenameRes,
      SessionRenameResSchema,
    ),
    pin: withSchema(
      IPC_META.session.pin,
      SessionPinReqSchema,
      {} as SessionPinRes,
      SessionPinResSchema,
    ),
    create: withSchema(
      IPC_META.session.create,
      SessionCreateReqSchema,
      {} as SessionCreateRes,
      SessionCreateResSchema,
    ),
    listRecentDirs: withSchema(
      IPC_META.session.listRecentDirs,
      SessionListRecentDirsReqSchema,
      {} as SessionListRecentDirsRes,
      SessionListRecentDirsResSchema,
    ),
    exportAll: withSchema(
      IPC_META.session.exportAll,
      null,
      {} as { saved: boolean; path?: string },
      z.object({ saved: z.boolean(), path: z.string().optional() }),
    ),
    getUsageSummary: withSchema(
      IPC_META.session.getUsageSummary,
      null,
      {} as UsageSummaryRes,
      UsageSummaryResSchema,
    ),
    getTurns: withSchema(
      IPC_META.session.getTurns,
      SessionGetTurnsReqSchema,
      {} as SessionGetTurnsRes,
      SessionGetTurnsResSchema,
    ),
    getRecentTurns: withSchema(
      IPC_META.session.getRecentTurns,
      SessionGetRecentTurnsReqSchema,
      {} as SessionRecentTurnsRes,
      SessionRecentTurnsResSchema,
    ),
    getTurnMessages: withSchema(
      IPC_META.session.getTurnMessages,
      SessionGetTurnMessagesReqSchema,
      {} as SessionGetTurnMessagesRes,
      SessionGetTurnMessagesResSchema,
    ),
    compact: withSchema(
      IPC_META.session.compact,
      SessionCompactReqSchema,
      {} as SessionCompactRes,
      SessionCompactResSchema,
    ),
  },

  file: {
    read: withSchema(IPC_META.file.read, FileReadReqSchema, {} as FileReadRes, FileReadResSchema),
    write: withSchema(
      IPC_META.file.write,
      FileWriteReqSchema,
      {} as FileWriteRes,
      FileWriteResSchema,
    ),
    list: withSchema(IPC_META.file.list, FileListReqSchema, {} as FileListRes, FileListResSchema),
    watchStart: withSchema(
      IPC_META.file.watchStart,
      FileWatchStartReqSchema,
      {} as FileWatchStartRes,
      FileWatchStartResSchema,
    ),
    watchStop: withSchema(
      IPC_META.file.watchStop,
      FileWatchStopReqSchema,
      {} as FileWatchStopRes,
      FileWatchStopResSchema,
    ),
    subscribeWatchEvent: withPayload(
      IPC_META.file.subscribeWatchEvent,
      {} as FileWatchEventPayload,
      FileWatchEventPayloadSchema,
    ),
    create: withSchema(
      IPC_META.file.create,
      FileCreateReqSchema,
      {} as FileCreateRes,
      FileCreateResSchema,
    ),
    createDir: withSchema(
      IPC_META.file.createDir,
      FileCreateDirReqSchema,
      {} as FileCreateDirRes,
      FileCreateDirResSchema,
    ),
    delete: withSchema(
      IPC_META.file.delete,
      FileDeleteReqSchema,
      {} as FileDeleteRes,
      FileDeleteResSchema,
    ),
    rename: withSchema(
      IPC_META.file.rename,
      FileRenameReqSchema,
      {} as FileRenameRes,
      FileRenameResSchema,
    ),
  },

  search: {
    grep: withSchema(IPC_META.search.grep, GrepReqSchema, {} as GrepRes, GrepResSchema),
    glob: withSchema(IPC_META.search.glob, GlobReqSchema, {} as GlobRes, GlobResSchema),
  },

  terminal: {
    create: withSchema(
      IPC_META.terminal.create,
      TerminalCreateReqSchema,
      {} as TerminalCreateRes,
      TerminalCreateResSchema,
    ),
    input: withSchema(
      IPC_META.terminal.input,
      TerminalInputReqSchema,
      {} as TerminalInputRes,
      TerminalInputResSchema,
    ),
    resize: withSchema(
      IPC_META.terminal.resize,
      TerminalResizeReqSchema,
      {} as TerminalResizeRes,
      TerminalResizeResSchema,
    ),
    kill: withSchema(
      IPC_META.terminal.kill,
      TerminalKillReqSchema,
      {} as TerminalKillRes,
      TerminalKillResSchema,
    ),
    subscribeCreatedEvent: withPayload(
      IPC_META.terminal.subscribeCreatedEvent,
      {} as TerminalCreatedEventPayload,
      TerminalCreatedEventPayloadSchema,
    ),
    subscribeOutputEvent: withPayload(
      IPC_META.terminal.subscribeOutputEvent,
      {} as TerminalOutputEventPayload,
      TerminalOutputEventPayloadSchema,
    ),
    subscribeExitEvent: withPayload(
      IPC_META.terminal.subscribeExitEvent,
      {} as TerminalExitEventPayload,
      TerminalExitEventPayloadSchema,
    ),
  },

  git: {
    status: withSchema(
      IPC_META.git.status,
      GitStatusReqSchema,
      {} as GitStatusRes,
      GitStatusResSchema,
    ),
    diff: withSchema(IPC_META.git.diff, GitDiffReqSchema, {} as GitDiffRes, GitDiffResSchema),
    add: withSchema(IPC_META.git.add, GitAddReqSchema, {} as GitAddRes, GitAddResSchema),
    commit: withSchema(
      IPC_META.git.commit,
      GitCommitReqSchema,
      {} as GitCommitRes,
      GitCommitResSchema,
    ),
    push: withSchema(IPC_META.git.push, GitPushReqSchema, {} as GitPushRes, GitPushResSchema),
  },

  codebase: {
    query: withSchema(
      IPC_META.codebase.query,
      CodebaseQueryReqSchema,
      {} as CodebaseQueryRes,
      CodebaseQueryResSchema,
    ),
    explore: withSchema(
      IPC_META.codebase.explore,
      CodebaseExploreReqSchema,
      {} as CodebaseExploreRes,
      CodebaseMarkdownResSchema,
    ),
    node: withSchema(
      IPC_META.codebase.node,
      CodebaseNodeReqSchema,
      {} as CodebaseNodeRes,
      CodebaseMarkdownResSchema,
    ),
    callers: withSchema(
      IPC_META.codebase.callers,
      CodebaseCallersReqSchema,
      {} as CodebaseCallersRes,
      CodebaseMarkdownResSchema,
    ),
    callees: withSchema(
      IPC_META.codebase.callees,
      CodebaseCalleesReqSchema,
      {} as CodebaseCalleesRes,
      CodebaseMarkdownResSchema,
    ),
    impact: withSchema(
      IPC_META.codebase.impact,
      CodebaseImpactReqSchema,
      {} as CodebaseImpactRes,
      CodebaseMarkdownResSchema,
    ),
  },

  tool: {
    list: withSchema(IPC_META.tool.list, ToolListReqSchema, {} as ToolListRes, ToolListResSchema),
  },

  settings: {
    getAll: withSchema(
      IPC_META.settings.getAll,
      SettingsGetAllReqSchema,
      {} as { settings: Record<string, unknown> },
      SettingsGetAllResSchema,
    ),
    set: withSchema(
      IPC_META.settings.set,
      SettingsSetReqSchema,
      {} as { ok: boolean },
      SettingsSetResSchema,
    ),
    getApiKey: withSchema(
      IPC_META.settings.getApiKey,
      GetApiKeyReqSchema,
      {} as GetApiKeyRes,
      GetApiKeyResSchema,
    ),
    setApiKey: withSchema(
      IPC_META.settings.setApiKey,
      SetApiKeyReqSchema,
      {} as SetApiKeyRes,
      SetApiKeyResSchema,
    ),
    deleteApiKey: withSchema(
      IPC_META.settings.deleteApiKey,
      DeleteApiKeyReqSchema,
      {} as DeleteApiKeyRes,
      DeleteApiKeyResSchema,
    ),
    getTelemetryLevel: withSchema(
      IPC_META.settings.getTelemetryLevel,
      null,
      {} as GetTelemetryLevelRes,
      GetTelemetryLevelResSchema,
    ),
    setTelemetryLevel: withSchema(
      IPC_META.settings.setTelemetryLevel,
      SetTelemetryLevelReqSchema,
      {} as SetTelemetryLevelRes,
      SetTelemetryLevelResSchema,
    ),
    getApprovalMode: withSchema(
      IPC_META.settings.getApprovalMode,
      null,
      {} as GetApprovalModeRes,
      GetApprovalModeResSchema,
    ),
    setApprovalMode: withSchema(
      IPC_META.settings.setApprovalMode,
      SetApprovalModeReqSchema,
      {} as SetApprovalModeRes,
      SetApprovalModeResSchema,
    ),
    addRuntimeModel: withSchema(
      IPC_META.settings.addRuntimeModel,
      AddRuntimeModelReqSchema,
      {} as AddRuntimeModelRes,
      AddRuntimeModelResSchema,
    ),
    removeRuntimeModel: withSchema(
      IPC_META.settings.removeRuntimeModel,
      RemoveRuntimeModelReqSchema,
      {} as RemoveRuntimeModelRes,
      RemoveRuntimeModelResSchema,
    ),
    listRuntimeModels: withSchema(
      IPC_META.settings.listRuntimeModels,
      null,
      {} as ListRuntimeModelsRes,
      ListRuntimeModelsResSchema,
    ),
    updateRuntimeModel: withSchema(
      IPC_META.settings.updateRuntimeModel,
      UpdateRuntimeModelReqSchema,
      {} as UpdateRuntimeModelRes,
      UpdateRuntimeModelResSchema,
    ),
  },

  system: {
    getStatus: withSchema(
      IPC_META.system.getStatus,
      null,
      {} as SystemStatusRes,
      SystemStatusResSchema,
    ),
  },

  models: {
    list: withSchema(IPC_META.models.list, null, {} as ModelsListRes, ModelsListResSchema),
    test: withSchema(
      IPC_META.models.test,
      TestModelReqSchema,
      {} as TestModelRes,
      TestModelResSchema,
    ),
  },

  memory: {
    list: withSchema(
      IPC_META.memory.list,
      MemoryListReqSchema,
      {} as MemoryListRes,
      MemoryListResSchema,
    ),
    clear: withSchema(
      IPC_META.memory.clear,
      MemoryClearReqSchema,
      {} as MemoryClearRes,
      MemoryClearResSchema,
    ),
  },

  task: {
    list: withSchema(IPC_META.task.list, TaskListReqSchema, {} as TaskListRes, TaskListResSchema),
  },

  skill: {
    list: withSchema(IPC_META.skill.list, null, {} as SkillListRes, SkillListResSchema),
    learn: withSchema(
      IPC_META.skill.learn,
      SkillLearnReqSchema,
      {} as { name: string; description: string; prompt: string; replaced: boolean },
      SkillLearnResSchema,
    ),
    listLearned: withSchema(
      IPC_META.skill.listLearned,
      z.object({}),
      {} as Array<{ name: string; description: string; prompt: string }>,
      SkillListLearnedResSchema,
    ),
    removeLearned: withSchema(
      IPC_META.skill.removeLearned,
      SkillRemoveReqSchema,
      {} as { removed: boolean },
      SkillRemoveLearnedResSchema,
    ),
  },

  whitelist: {
    list: withSchema(IPC_META.whitelist.list, null, {} as WhitelistListRes, WhitelistListResSchema),
    add: withSchema(
      IPC_META.whitelist.add,
      WhitelistAddReqSchema,
      {} as WhitelistAddRes,
      OkResSchema,
    ),
    remove: withSchema(
      IPC_META.whitelist.remove,
      WhitelistRemoveReqSchema,
      {} as WhitelistRemoveRes,
      OkResSchema,
    ),
  },

  goal: {
    create: withSchema(IPC_META.goal.create, GoalCreateReqSchema, {} as GoalCreateRes, OkResSchema),
    list: withSchema(IPC_META.goal.list, GoalListReqSchema, {} as GoalListRes, GoalListResSchema),
    clear: withSchema(
      IPC_META.goal.clear,
      GoalClearReqSchema,
      {} as GoalClearRes,
      GoalClearResSchema,
    ),
  },

  im: {
    list: withSchema(IPC_META.im.list, null, {} as ChannelListRes, ChannelListResSchema),
    start: withSchema(IPC_META.im.start, ChannelStartReqSchema, {} as ChannelOpRes, OkResSchema),
    stop: withSchema(IPC_META.im.stop, ChannelStopReqSchema, {} as ChannelOpRes, OkResSchema),
  },

  logs: {
    read: withSchema(IPC_META.logs.read, ReadLogsReqSchema, {} as ReadLogsRes, ReadLogsResSchema),
  },

  devtools: {
    open: withSchema(
      IPC_META.devtools.open,
      OpenDevToolsReqSchema,
      {} as OpenDevToolsRes,
      OpenDevToolsResSchema,
    ),
  },

  dialog: {
    pickDirectory: withSchema(
      IPC_META.dialog.pickDirectory,
      DialogPickDirectoryReqSchema,
      {} as DialogPickDirectoryRes,
      DialogPickDirectoryResSchema,
    ),
    pickFiles: withSchema(
      IPC_META.dialog.pickFiles,
      DialogPickFilesReqSchema,
      {} as DialogPickFilesRes,
      DialogPickFilesResSchema,
    ),
  },

  mcp: {
    list: withSchema(IPC_META.mcp.list, McpListReqSchema, {} as McpListRes, McpListResSchema),
    start: withSchema(IPC_META.mcp.start, McpServerConfigSchema, {} as McpStartRes, OkResSchema),
    stop: withSchema(IPC_META.mcp.stop, McpStopReqSchema, {} as McpStopRes, OkResSchema),
  },

  update: {
    check: withSchema(
      IPC_META.update.check,
      UpdateCheckReqSchema,
      {} as UpdateCheckRes,
      UpdateCheckResSchema,
    ),
    install: withSchema(IPC_META.update.install, null, {} as { ok: boolean }, OkResSchema),
    subscribeStatus: withPayload(
      IPC_META.update.subscribeStatus,
      {} as UpdateStatusPayload,
      UpdateStatusPayloadSchema,
    ),
  },
} as const;

/** IPC 定义表类型 */
export type IpcDefinitions = typeof IPC_DEFINITIONS;

/** 元数据表类型透传（供 preload 生成器类型约束） */
export type { IpcMeta };

// ─── 编译期双向同步检查（P2 修复） ─────────────────────────────────────
// 此前 "definitions ⊆ meta" 靠构造方式保证（definitions 引用 meta 条目），
// 但 "meta ⊆ definitions"（meta 多写一个方法）没有任何编译期检查——
// preload 会照常暴露该方法，register 却不注册，运行时 "No handler registered"。
// 此处的类型相等检查让两个方向都在编译期成立：任何一侧漂移直接报错。
// 注意：const 声明只是占位（typeof 推断），不产生运行时代码。
type _MissingMethods<A, B> = {
  [K in keyof A]: K extends keyof B
    ? Exclude<keyof A[K], keyof B[K]> extends never
      ? true
      : { domain: K; missingInB: Exclude<keyof A[K], keyof B[K]> }
    : { domain: K; domainMissingInB: true };
}[keyof A];

// meta ⊆ definitions（meta 多写方法 → 编译失败）
const _metaCoversDefs: _MissingMethods<typeof IPC_META, typeof IPC_DEFINITIONS> = true;
// definitions ⊆ meta（definitions 多写方法 → 编译失败）
const _defsCoversMeta: _MissingMethods<typeof IPC_DEFINITIONS, typeof IPC_META> = true;
// 占位使用，避免 noUnusedLocals（类型检查即价值所在）
void _metaCoversDefs;
void _defsCoversMeta;
