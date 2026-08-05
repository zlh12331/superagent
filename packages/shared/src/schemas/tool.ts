// packages/shared/src/schemas/tool.ts
// Tool 域 zod schema 单一真源（Code Agent 工具系统）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 Tool 域 zod schema 与 TypeScript 接口，作为工具系统的类型契约
// - 不直接定义 Tool 接口本身（Tool 接口在主进程 main/infra/ai/tool.ts 中定义，
//   依赖 ZodType 与 execute 函数，属于主进程范畴）
// - 本文件只定义可跨进程共享的元数据类型（ToolPermission / ToolDescriptor /
//   ToolError / ToolResult / ToolListReq / ToolListRes）
//
// 设计原则：
// - 渲染层不感知具体的工具实现，仅通过 ToolDescriptor 展示工具清单
// - 工具入参 input / 输出 output 用 z.unknown()：具体结构由工具自身 schema 定义，
//   IPC 层不强制校验（避免 shared 包耦合具体工具）
// - 权限模式 ToolPermission 与用户决策对齐：白名单自动 + 危险询问
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * 工具权限级别（字面量联合类型）
 *
 * 与用户决策对齐：
 * - 'auto'：白名单工具（只读操作，如 read_file / grep / glob / list_directory），
 *           自动执行无需用户审批
 * - 'ask'：危险工具（写操作 / 执行命令，如 write_file / run_command），
 *          需通过 ApprovalModal 请求用户审批
 *
 * 与 AgentToolCallPayload.permission / AgentApprovalRequestPayload 字段对齐，
 * 与 AI SDK v7 的 toolApproval 状态映射：
 * - 'auto' → toolApproval 返回 'approved'
 * - 'ask'  → toolApproval 返回 'user-approval'
 */
export const ToolPermissionSchema = z.enum(['auto', 'ask', 'deny']);

/** 工具权限级别 TypeScript 类型（z.infer 派生） */
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

/**
 * 工具错误 zod schema
 *
 * 结构与 AgentToolResultPayload.error 对齐（code + message）：
 * - code 与 AppError.code 对齐（如 TOOL_EXECUTION_FAILED / TOOL_PERMISSION_DENIED）
 * - message 人类可读，用于渲染层 toast
 */
export const ToolErrorSchema = z.object({
  /** 错误码（与 @code-agent/shared 的 ErrorCode 对齐） */
  code: z.string().min(1),
  /** 人类可读错误消息 */
  message: z.string().min(1),
});

/** 工具错误 TypeScript 类型（z.infer 派生） */
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * 工具执行结果 zod schema
 *
 * output 为 unknown：工具自身决定输出结构（如 read_file 返回 { content }，
 * write_file 返回 { bytesWritten }），IPC 层不强制约束。
 *
 * error 为可选：有值表示执行失败，无值表示成功。
 * exactOptionalPropertyTypes 兼容：用 `.optional().transform(v => v ?? undefined)`
 * 让 output 类型为 `ToolError | undefined`。
 */
export const ToolResultSchema = z.object({
  /** 工具调用 id（与 AI SDK 的 toolCallId 配对） */
  toolCallId: z.string().min(1),
  /** 工具名称 */
  toolName: z.string().min(1),
  /** 工具输出（结构由工具自身决定） */
  output: z.unknown(),
  /** 执行错误（有值表示失败，无值表示成功） */
  error: ToolErrorSchema.optional().transform((v) => v ?? undefined),
});

/** 工具执行结果 TypeScript 类型（z.infer 派生） */
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * 工具元数据 zod schema
 *
 * 用于 IPC 向渲染层暴露工具清单（tool:list channel），渲染层据此展示
 * 可用工具列表及权限级别，无需感知工具具体实现。
 *
 * inputSchema 不通过 IPC 传输（ZodType 不可序列化），
 * 渲染层如需校验入参可调用 tool:validate 或直接在主进程校验。
 */
export const ToolDescriptorSchema = z.object({
  /** 工具唯一名称（kebab-case，如 read_file / write_file） */
  name: z.string().min(1),
  /** 工具描述（LLM 据此决定是否调用，应清晰说明用途） */
  description: z.string().min(1),
  /** 权限级别：'auto' 自动执行 / 'ask' 需用户审批 */
  permission: ToolPermissionSchema,
});

/** 工具元数据 TypeScript 类型（z.infer 派生） */
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/**
 * tool:list 请求 payload：列出当前已注册的工具清单
 *
 * 渲染层启动时调用一次，展示工具面板；后续可通过 tool:added / tool:removed
 * 事件增量更新（当前阶段不实现，后续按需扩展）。
 *
 * permission 过滤可选：省略则列出全部工具，传 'auto' 仅列白名单工具，
 * 传 'ask' 仅列需审批工具。
 *
 * 注意：Req 类型 `ToolListReq` 在 ipc/payloads.ts 中通过 z.infer 派生，
 * 与其他域（agent/file/search/...）的惯例保持一致，避免类型多处定义冲突。
 */
export const ToolListReqSchema = z.object({
  permission: ToolPermissionSchema.optional().transform((v) => v ?? undefined),
});

/**
 * tool:list 响应 payload：工具元数据清单
 *
 * 工具清单按 name 字母序排序，确保跨进程一致。
 */
export interface ToolListRes {
  /** 工具元数据清单（按 name 字母序） */
  readonly tools: readonly ToolDescriptor[];
}
