// packages/shared/src/schemas/agent.ts
// Agent 域 zod schema 单一真源（Code Agent 核心）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 Agent 域所有 zod schema，作为 IPC 入参运行时校验的单一真源
// - 类型（AgentRunReq / AgentStopReq 等）从 schema 派生（z.infer）
// - 供主进程 IPC handler 校验入参，避免 handler 内联 schema 重复定义
//
// 设计：
// - 复用 ChatMessageSchema 作为消息历史元素（Code Agent 的对话历史与 chat 域同构）
// - sessionId / systemPrompt 用 `.optional().transform(v => v ?? undefined)`
//   让 output 类型为 `string | undefined`，兼容 exactOptionalPropertyTypes
// - 工具入参 input / 输出 output 用 z.unknown()：具体结构由 ToolRegistry 动态定义，
//   IPC 层不强制校验（由工具 schema 自行校验）
// ──────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai';
import { z } from 'zod';

import { ChatMessageSchema } from './chat';

/**
 * Agent 运行入参 zod schema
 *
 * 与 chat:send 的区别：
 * - chat:send 单轮流式响应（streamText 不带 tools）
 * - agent:run 多轮工具调用（streamText 带 tools + maxSteps，自动循环）
 *
 * workingDir 是 Code Agent 的核心约束：所有文件操作工具必须限制在 workingDir 内，
 * 防止 Agent 越权读写工作目录之外的文件。
 *
 * maxSteps 限制单次对话的最大工具调用轮数，避免无限循环消耗 token。
 */
export const AgentRunReqSchema = z.object({
  // 完整消息历史（含 user/assistant/tool-call/tool-result）
  messages: z.array(ChatMessageSchema).min(1),
  // 可选 sessionId：续传已有会话；省略则生成新会话
  sessionId: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 工作目录：限制所有文件操作的根目录
  workingDir: z.string().min(1),
  // 可选系统提示词（覆盖默认 system prompt）
  systemPrompt: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 最大工具调用轮数（默认 20，避免无限循环）
  maxSteps: z.number().int().positive().max(50).default(20),
});

/** Agent 中断入参 zod schema */
export const AgentStopReqSchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * Agent 运行响应：返回 sessionId
 *
 * 渲染层用此 id 订阅后续流式事件（agent:stream:* / agent:tool:* / agent:approval:*）
 */
export interface AgentRunRes {
  readonly sessionId: string;
}

/** Agent 中断响应 */
export interface AgentStopRes {
  /** 是否成功中断（对话已结束则返回 false） */
  readonly stopped: boolean;
}

/**
 * 工具调用事件 payload（主进程 → 渲染层）
 *
 * 当 AgentService 检测到 LLM 发起 tool call 时，通过此 payload 推送工具调用详情。
 * 渲染层据此渲染 ToolCallView（diff 预览、命令确认等）。
 *
 * permission 字段决定渲染层是否需要等待用户审批：
 * - 'auto'：白名单工具（只读），自动执行，渲染层仅展示
 * - 'ask'：危险工具（写文件/执行命令），需要等待 agent:approval:response
 */
export interface AgentToolCallPayload {
  readonly sessionId: string;
  /** AI SDK 生成的工具调用唯一 id（与 tool-result 配对） */
  readonly toolCallId: string;
  /** 工具名称（如 read_file / write_file / run_command） */
  readonly toolName: string;
  /** 工具入参（结构由工具 schema 决定） */
  readonly input: unknown;
  /** 权限级别：'auto' 自动执行 / 'ask' 需要用户确认 */
  readonly permission: 'auto' | 'ask';
}

/**
 * 工具执行结果事件 payload（主进程 → 渲染层）
 *
 * ToolExecutor 执行完成后推送，渲染层据此更新工具调用 UI 的状态（成功/失败）。
 * error 为 undefined 表示执行成功；有值表示失败（含错误码与消息）。
 *
 * 标准化返回结构（对齐 ToolResult）：
 * - title：人类可读标题（UI 展示用）
 * - output：给 LLM 看的文本输出
 * - metadata：结构化元数据（UI 可解析展示）
 */
export interface AgentToolResultPayload {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 人类可读标题（UI 展示用，如 "读取文件: src/main.ts"） */
  readonly title: string;
  /** 工具输出（给 LLM 看的文本） */
  readonly output: unknown;
  /** 结构化元数据（可选，UI 可解析展示） */
  readonly metadata?: Record<string, unknown>;
  /** 失败时携带错误信息；成功时为 undefined */
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * 审批请求 payload（主进程 → 渲染层）
 *
 * 当工具 permission='ask' 时，主进程推送此 payload 请求用户审批。
 * 渲染层弹出 ApprovalModal，用户选择后通过 agent:approval:response 回传结果。
 *
 * approvalId 是审批会话的唯一标识，主进程内部维护 approvalId → Promise 的 Map，
 * 收到 response 后 resolve 对应的 Promise，让 ToolExecutor 继续执行或抛出 TOOL_PERMISSION_DENIED。
 */
export interface AgentApprovalRequestPayload {
  readonly sessionId: string;
  /** 审批请求唯一 id（主进程生成，回传时作为 key） */
  readonly approvalId: string;
  /** 关联的工具调用 id（与 AgentToolCallPayload.toolCallId 对应） */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** 人类可读的操作摘要（如 "写入文件 /path/to/file.ts"），用于 ApprovalModal 展示 */
  readonly description: string;
}

/**
 * 审批响应 zod schema（渲染层 → 主进程，请求-响应）
 *
 * 渲染层 ApprovalModal 用户操作后，通过 ipcRenderer.invoke('agent:approval:response', req) 回传。
 * 主进程 IPC handler 用此 schema 校验入参，再调用 PermissionService.handleApprovalResponse。
 *
 * 注意：对应的 TypeScript 类型 AgentApprovalResponseReq 在 ipc/payloads.ts 通过 z.infer 派生，
 * 与其他域的 Req 类型派生惯例一致（schema 在 schemas/ 下定义，类型在 payloads.ts 派生）。
 */
export const AgentApprovalResponseReqSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  rememberDecision: z.boolean(),
});

/**
 * Agent 流式 part payload
 *
 * 复用 chat 域的 ChatStreamPartPayload 结构：part 类型为 UIMessageStreamPart 序列化对象。
 * 与 chat:stream:part 协议一致，便于渲染层复用流式推送逻辑。
 */
export interface AgentStreamPartPayload {
  readonly sessionId: string;
  /** UIMessageStreamPart 的 JSON 序列化对象（text-delta/tool-call/tool-result/finish 等） */
  readonly part: unknown;
}

/** Agent 流式结束 payload */
export interface AgentStreamEndPayload {
  readonly sessionId: string;
  /** 结束原因：'completed' 正常完成 / 'aborted' 用户中断 / 'error' 异常（已推送 error） */
  readonly reason: 'completed' | 'aborted' | 'error';
}

/** Agent 流式错误 payload */
export interface AgentStreamErrorPayload {
  readonly sessionId: string;
  /** 错误码（与 AppError.code 对齐） */
  readonly code: string;
  /** 错误消息（人类可读，用于渲染层 toast） */
  readonly message: string;
}

/**
 * Agent 消息类型（Code Agent 对话历史元素）
 *
 * 复用 AI SDK 的 ModelMessage 类型，支持 user/assistant/system/tool 四种角色，
 * 与 ChatMessage 同构（Code Agent 与 chat 域共享消息协议）。
 */
export type AgentMessage = ModelMessage;
