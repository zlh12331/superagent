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
  AgentApprovalResponseReqSchema,
  AgentRunReqSchema,
  type AgentRunRes,
  AgentStopReqSchema,
  type AgentStopRes,
  type AgentStreamEndPayload,
  type AgentStreamErrorPayload,
  type AgentStreamPartPayload,
  type AgentToolCallPayload,
  type AgentToolResultPayload,
} from '../schemas/agent';
import type { TurnEvent } from '../schemas/agent-events';
import { ChatSendReqSchema, ChatStopReqSchema } from '../schemas/chat';
import {
  CodebaseCalleesReqSchema,
  type CodebaseCalleesRes,
  CodebaseCallersReqSchema,
  type CodebaseCallersRes,
  CodebaseExploreReqSchema,
  type CodebaseExploreRes,
  CodebaseImpactReqSchema,
  type CodebaseImpactRes,
  CodebaseNodeReqSchema,
  type CodebaseNodeRes,
  CodebaseQueryReqSchema,
  type CodebaseQueryRes,
} from '../schemas/codebase';
import { OpenDevToolsReqSchema, type OpenDevToolsRes } from '../schemas/devtools';
import { DialogPickDirectoryReqSchema, type DialogPickDirectoryRes } from '../schemas/dialog';
import {
  FileCreateDirReqSchema,
  type FileCreateDirRes,
  FileCreateReqSchema,
  type FileCreateRes,
  FileDeleteReqSchema,
  type FileDeleteRes,
  FileListReqSchema,
  type FileListRes,
  FileReadReqSchema,
  type FileReadRes,
  FileRenameReqSchema,
  type FileRenameRes,
  type FileWatchEventPayload,
  FileWatchStartReqSchema,
  type FileWatchStartRes,
  FileWatchStopReqSchema,
  type FileWatchStopRes,
  FileWriteReqSchema,
  type FileWriteRes,
} from '../schemas/file';
import {
  GitAddReqSchema,
  type GitAddRes,
  GitCommitReqSchema,
  type GitCommitRes,
  GitDiffReqSchema,
  type GitDiffRes,
  GitPushReqSchema,
  type GitPushRes,
  GitStatusReqSchema,
  type GitStatusRes,
} from '../schemas/git';
import {
  GoalClearReqSchema,
  type GoalClearRes,
  GoalCreateReqSchema,
  type GoalCreateRes,
  GoalListReqSchema,
  type GoalListRes,
} from '../schemas/goal';
import type { ChannelListRes, ChannelOpRes } from '../schemas/im';
import { ChannelStartReqSchema, ChannelStopReqSchema } from '../schemas/im';
import {
  MemoryClearReqSchema,
  type MemoryClearRes,
  MemoryListReqSchema,
  type MemoryListRes,
} from '../schemas/memory';
import { GlobReqSchema, type GlobRes, GrepReqSchema, type GrepRes } from '../schemas/search';
import {
  SessionCreateReqSchema,
  type SessionCreateRes,
  SessionDeleteReqSchema,
  type SessionDeleteRes,
  SessionGetRecentTurnsReqSchema,
  SessionGetReqSchema,
  type SessionGetRes,
  SessionGetTurnMessagesReqSchema,
  type SessionGetTurnMessagesRes,
  SessionGetTurnsReqSchema,
  type SessionGetTurnsRes,
  SessionListRecentDirsReqSchema,
  type SessionListRecentDirsRes,
  SessionListReqSchema,
  type SessionListRes,
  type SessionRecentTurnsRes,
  SessionRenameReqSchema,
  type SessionRenameRes,
  type UsageSummaryRes,
} from '../schemas/session';
import {
  AddRuntimeModelReqSchema,
  type AddRuntimeModelRes,
  DeleteApiKeyReqSchema,
  type DeleteApiKeyRes,
  GetApiKeyReqSchema,
  type GetApiKeyRes,
  type GetApprovalModeRes,
  type GetTelemetryLevelRes,
  type ListRuntimeModelsRes,
  RemoveRuntimeModelReqSchema,
  type RemoveRuntimeModelRes,
  SetApiKeyReqSchema,
  type SetApiKeyRes,
  SetApprovalModeReqSchema,
  type SetApprovalModeRes,
  SetTelemetryLevelReqSchema,
  type SetTelemetryLevelRes,
} from '../schemas/settings';
import type { SkillListRes } from '../schemas/skill';
import { ReadLogsReqSchema, type ReadLogsRes, type SystemStatusRes } from '../schemas/system';
import { TaskListReqSchema, type TaskListRes } from '../schemas/task';
import {
  type TerminalCreatedEventPayload,
  TerminalCreateReqSchema,
  type TerminalCreateRes,
  type TerminalExitEventPayload,
  TerminalInputReqSchema,
  type TerminalInputRes,
  TerminalKillReqSchema,
  type TerminalKillRes,
  type TerminalOutputEventPayload,
  TerminalResizeReqSchema,
  type TerminalResizeRes,
} from '../schemas/terminal';
import { ToolListReqSchema, type ToolListRes } from '../schemas/tool';
import {
  UpdateCheckReqSchema,
  type UpdateCheckRes,
  type UpdateStatusPayload,
} from '../schemas/update';
import { IPC_META, type IpcMeta } from './meta';

/**
 * 在元数据基础上合并 schema 与响应类型标记（request 方法）
 *
 * @param meta 来自 IPC_META 的 request 条目
 * @param schema 入参 zod schema（null 表示无入参）
 * @param res 响应类型标记（仅编译期类型用途，运行时忽略）
 */
export function withSchema<
  M extends { readonly kind: 'request'; readonly channel: string },
  S extends z.ZodType | null,
  R,
>(meta: M, schema: S, _res: R): M & { readonly schema: S; readonly res: R } {
  return { ...meta, schema, res: undefined as unknown as R };
}

/**
 * 在元数据基础上合并事件 payload 类型标记（event 方法）
 *
 * @param meta 来自 IPC_META 的 event 条目
 * @param payload payload 类型标记（仅编译期类型用途，运行时忽略）
 */
export function withPayload<M extends { readonly kind: 'event'; readonly channel: string }, P>(
  meta: M,
  _payload: P,
): M & { readonly payload: P } {
  return { ...meta, payload: undefined as unknown as P };
}

/**
 * IPC 定义表（完整：channel + schema + 类型）
 *
 * 新增方法：在 IPC_META 加一行，再在本文件用 withSchema/withPayload 合并 schema。
 * preload 生成器自动同步（消费 IPC_META），handler 缺失在编译期报错（InferHandlers）。
 */
export const IPC_DEFINITIONS = {
  app: {
    getStatus: withSchema(IPC_META.app.getStatus, null, {} as { ready: boolean }),
    openExternal: withSchema(
      IPC_META.app.openExternal,
      z.object({ url: z.string().min(1, 'URL 不能为空') }),
      {} as { ok: boolean },
    ),
    openDataDir: withSchema(IPC_META.app.openDataDir, null, {} as { ok: boolean }),
  },

  chat: {
    send: withSchema(IPC_META.chat.send, ChatSendReqSchema, {} as { sessionId: string }),
    stop: withSchema(IPC_META.chat.stop, ChatStopReqSchema, {} as { stopped: boolean }),
    subscribePart: withPayload(IPC_META.chat.subscribePart, {} as AgentStreamPartPayload),
    subscribeEnd: withPayload(IPC_META.chat.subscribeEnd, {} as AgentStreamEndPayload),
    subscribeError: withPayload(IPC_META.chat.subscribeError, {} as AgentStreamErrorPayload),
  },

  agent: {
    run: withSchema(IPC_META.agent.run, AgentRunReqSchema, {} as AgentRunRes),
    stop: withSchema(IPC_META.agent.stop, AgentStopReqSchema, {} as AgentStopRes),
    approvalResponse: withSchema(
      IPC_META.agent.approvalResponse,
      AgentApprovalResponseReqSchema,
      {} as { ok: boolean },
    ),
    subscribeStreamPart: withPayload(
      IPC_META.agent.subscribeStreamPart,
      {} as AgentStreamPartPayload,
    ),
    subscribeStreamEnd: withPayload(IPC_META.agent.subscribeStreamEnd, {} as AgentStreamEndPayload),
    subscribeStreamError: withPayload(
      IPC_META.agent.subscribeStreamError,
      {} as AgentStreamErrorPayload,
    ),
    subscribeToolCall: withPayload(IPC_META.agent.subscribeToolCall, {} as AgentToolCallPayload),
    subscribeToolResult: withPayload(
      IPC_META.agent.subscribeToolResult,
      {} as AgentToolResultPayload,
    ),
    subscribeApprovalRequest: withPayload(
      IPC_META.agent.subscribeApprovalRequest,
      {} as AgentApprovalRequestPayload,
    ),
    subscribeTurnEvent: withPayload(IPC_META.agent.subscribeTurnEvent, {} as TurnEvent),
  },

  session: {
    list: withSchema(IPC_META.session.list, SessionListReqSchema, {} as SessionListRes),
    get: withSchema(IPC_META.session.get, SessionGetReqSchema, {} as SessionGetRes),
    delete: withSchema(IPC_META.session.delete, SessionDeleteReqSchema, {} as SessionDeleteRes),
    rename: withSchema(IPC_META.session.rename, SessionRenameReqSchema, {} as SessionRenameRes),
    create: withSchema(IPC_META.session.create, SessionCreateReqSchema, {} as SessionCreateRes),
    listRecentDirs: withSchema(
      IPC_META.session.listRecentDirs,
      SessionListRecentDirsReqSchema,
      {} as SessionListRecentDirsRes,
    ),
    exportAll: withSchema(
      IPC_META.session.exportAll,
      null,
      {} as { saved: boolean; path?: string },
    ),
    getUsageSummary: withSchema(IPC_META.session.getUsageSummary, null, {} as UsageSummaryRes),
    getTurns: withSchema(
      IPC_META.session.getTurns,
      SessionGetTurnsReqSchema,
      {} as SessionGetTurnsRes,
    ),
    getRecentTurns: withSchema(
      IPC_META.session.getRecentTurns,
      SessionGetRecentTurnsReqSchema,
      {} as SessionRecentTurnsRes,
    ),
    getTurnMessages: withSchema(
      IPC_META.session.getTurnMessages,
      SessionGetTurnMessagesReqSchema,
      {} as SessionGetTurnMessagesRes,
    ),
  },

  file: {
    read: withSchema(IPC_META.file.read, FileReadReqSchema, {} as FileReadRes),
    write: withSchema(IPC_META.file.write, FileWriteReqSchema, {} as FileWriteRes),
    list: withSchema(IPC_META.file.list, FileListReqSchema, {} as FileListRes),
    watchStart: withSchema(
      IPC_META.file.watchStart,
      FileWatchStartReqSchema,
      {} as FileWatchStartRes,
    ),
    watchStop: withSchema(IPC_META.file.watchStop, FileWatchStopReqSchema, {} as FileWatchStopRes),
    subscribeWatchEvent: withPayload(
      IPC_META.file.subscribeWatchEvent,
      {} as FileWatchEventPayload,
    ),
    create: withSchema(IPC_META.file.create, FileCreateReqSchema, {} as FileCreateRes),
    createDir: withSchema(IPC_META.file.createDir, FileCreateDirReqSchema, {} as FileCreateDirRes),
    delete: withSchema(IPC_META.file.delete, FileDeleteReqSchema, {} as FileDeleteRes),
    rename: withSchema(IPC_META.file.rename, FileRenameReqSchema, {} as FileRenameRes),
  },

  search: {
    grep: withSchema(IPC_META.search.grep, GrepReqSchema, {} as GrepRes),
    glob: withSchema(IPC_META.search.glob, GlobReqSchema, {} as GlobRes),
  },

  terminal: {
    create: withSchema(IPC_META.terminal.create, TerminalCreateReqSchema, {} as TerminalCreateRes),
    input: withSchema(IPC_META.terminal.input, TerminalInputReqSchema, {} as TerminalInputRes),
    resize: withSchema(IPC_META.terminal.resize, TerminalResizeReqSchema, {} as TerminalResizeRes),
    kill: withSchema(IPC_META.terminal.kill, TerminalKillReqSchema, {} as TerminalKillRes),
    subscribeCreatedEvent: withPayload(
      IPC_META.terminal.subscribeCreatedEvent,
      {} as TerminalCreatedEventPayload,
    ),
    subscribeOutputEvent: withPayload(
      IPC_META.terminal.subscribeOutputEvent,
      {} as TerminalOutputEventPayload,
    ),
    subscribeExitEvent: withPayload(
      IPC_META.terminal.subscribeExitEvent,
      {} as TerminalExitEventPayload,
    ),
  },

  git: {
    status: withSchema(IPC_META.git.status, GitStatusReqSchema, {} as GitStatusRes),
    diff: withSchema(IPC_META.git.diff, GitDiffReqSchema, {} as GitDiffRes),
    add: withSchema(IPC_META.git.add, GitAddReqSchema, {} as GitAddRes),
    commit: withSchema(IPC_META.git.commit, GitCommitReqSchema, {} as GitCommitRes),
    push: withSchema(IPC_META.git.push, GitPushReqSchema, {} as GitPushRes),
  },

  codebase: {
    query: withSchema(IPC_META.codebase.query, CodebaseQueryReqSchema, {} as CodebaseQueryRes),
    explore: withSchema(
      IPC_META.codebase.explore,
      CodebaseExploreReqSchema,
      {} as CodebaseExploreRes,
    ),
    node: withSchema(IPC_META.codebase.node, CodebaseNodeReqSchema, {} as CodebaseNodeRes),
    callers: withSchema(
      IPC_META.codebase.callers,
      CodebaseCallersReqSchema,
      {} as CodebaseCallersRes,
    ),
    callees: withSchema(
      IPC_META.codebase.callees,
      CodebaseCalleesReqSchema,
      {} as CodebaseCalleesRes,
    ),
    impact: withSchema(IPC_META.codebase.impact, CodebaseImpactReqSchema, {} as CodebaseImpactRes),
  },

  tool: {
    list: withSchema(IPC_META.tool.list, ToolListReqSchema, {} as ToolListRes),
  },

  settings: {
    getApiKey: withSchema(IPC_META.settings.getApiKey, GetApiKeyReqSchema, {} as GetApiKeyRes),
    setApiKey: withSchema(IPC_META.settings.setApiKey, SetApiKeyReqSchema, {} as SetApiKeyRes),
    deleteApiKey: withSchema(
      IPC_META.settings.deleteApiKey,
      DeleteApiKeyReqSchema,
      {} as DeleteApiKeyRes,
    ),
    getTelemetryLevel: withSchema(
      IPC_META.settings.getTelemetryLevel,
      null,
      {} as GetTelemetryLevelRes,
    ),
    setTelemetryLevel: withSchema(
      IPC_META.settings.setTelemetryLevel,
      SetTelemetryLevelReqSchema,
      {} as SetTelemetryLevelRes,
    ),
    getApprovalMode: withSchema(IPC_META.settings.getApprovalMode, null, {} as GetApprovalModeRes),
    setApprovalMode: withSchema(
      IPC_META.settings.setApprovalMode,
      SetApprovalModeReqSchema,
      {} as SetApprovalModeRes,
    ),
    addRuntimeModel: withSchema(
      IPC_META.settings.addRuntimeModel,
      AddRuntimeModelReqSchema,
      {} as AddRuntimeModelRes,
    ),
    removeRuntimeModel: withSchema(
      IPC_META.settings.removeRuntimeModel,
      RemoveRuntimeModelReqSchema,
      {} as RemoveRuntimeModelRes,
    ),
    listRuntimeModels: withSchema(
      IPC_META.settings.listRuntimeModels,
      null,
      {} as ListRuntimeModelsRes,
    ),
  },

  system: {
    getStatus: withSchema(IPC_META.system.getStatus, null, {} as SystemStatusRes),
  },

  memory: {
    list: withSchema(IPC_META.memory.list, MemoryListReqSchema, {} as MemoryListRes),
    clear: withSchema(IPC_META.memory.clear, MemoryClearReqSchema, {} as MemoryClearRes),
  },

  task: {
    list: withSchema(IPC_META.task.list, TaskListReqSchema, {} as TaskListRes),
  },

  skill: {
    list: withSchema(IPC_META.skill.list, null, {} as SkillListRes),
  },

  goal: {
    create: withSchema(IPC_META.goal.create, GoalCreateReqSchema, {} as GoalCreateRes),
    list: withSchema(IPC_META.goal.list, GoalListReqSchema, {} as GoalListRes),
    clear: withSchema(IPC_META.goal.clear, GoalClearReqSchema, {} as GoalClearRes),
  },

  im: {
    list: withSchema(IPC_META.im.list, null, {} as ChannelListRes),
    start: withSchema(IPC_META.im.start, ChannelStartReqSchema, {} as ChannelOpRes),
    stop: withSchema(IPC_META.im.stop, ChannelStopReqSchema, {} as ChannelOpRes),
  },

  logs: {
    read: withSchema(IPC_META.logs.read, ReadLogsReqSchema, {} as ReadLogsRes),
  },

  devtools: {
    open: withSchema(IPC_META.devtools.open, OpenDevToolsReqSchema, {} as OpenDevToolsRes),
  },

  dialog: {
    pickDirectory: withSchema(
      IPC_META.dialog.pickDirectory,
      DialogPickDirectoryReqSchema,
      {} as DialogPickDirectoryRes,
    ),
  },

  update: {
    check: withSchema(IPC_META.update.check, UpdateCheckReqSchema, {} as UpdateCheckRes),
    install: withSchema(IPC_META.update.install, null, {} as { ok: boolean }),
    subscribeStatus: withPayload(IPC_META.update.subscribeStatus, {} as UpdateStatusPayload),
  },
} as const;

/** IPC 定义表类型 */
export type IpcDefinitions = typeof IPC_DEFINITIONS;

/** 元数据表类型透传（供 preload 生成器类型约束） */
export type { IpcMeta };
