// tool.ts：Tool 域 zod 契约单一真源——工具权限值域、错误/结果形状，以及渲染层可见的工具清单
// （ToolDescriptor 与 tool:list 请求/响应）。
// 边界：不定义 Tool 接口本身（inputSchema 与 execute 属主进程范畴，见
// src/main/infra/ai/tools/tool.ts）；工具入参/输出结构由各工具自己的 schema 决定，
// 此处 output 一律 z.unknown()，IPC 层不强制校验。

import { z } from 'zod';

/**
 * 工具权限级别（字面量联合类型）
 *
 * 三种取值的来源不同：
 * - 'auto'：工具声明的免审批级别（只读类工具，如 read_file / grep / glob / list_directory）
 * - 'ask'：工具声明的需审批级别（写操作 / 执行命令，如 write_file / run_command）——
 *   主进程推 agent:approval:request，渲染层裁决后经 agent:approval:response 回传
 * - 'deny'：拒绝执行——不是工具声明值，而是权限决策产物（如 plan 模式对非只读工具的硬拦截），
 *   渲染层工具卡片直接展示拒绝态
 *
 * 与 AgentToolCallPayload.permission 值域一致（agent:tool:call 事件携带决策后的级别）。
 */
export const ToolPermissionSchema = z.enum(['auto', 'ask', 'deny']);

/** 工具权限级别 TypeScript 类型（z.infer 派生） */
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

// ────────── 工具调用结果：错误与标准化返回 ──────────

/**
 * 工具错误 zod schema
 *
 * 与 AgentToolResultPayload.error 同形（code + message，packages/shared/src/schemas/agent.ts）：
 * - code：AppError.code 值域（ErrorCode，如 TOOL_EXECUTION_FAILED / TOOL_PERMISSION_DENIED）
 * - message：人类可读文案
 */
export const ToolErrorSchema = z.object({
  /** 错误码（取 packages/shared/src/constants/errors.ts 的 ErrorCode） */
  code: z.string().min(1),
  /** 人类可读错误消息 */
  message: z.string().min(1),
});

/** 工具错误 TypeScript 类型（z.infer 派生） */
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * 工具执行结果 zod schema
 *
 * output 为 z.unknown()：输出结构由各工具自定（避免 shared 包耦合具体工具），IPC 层不强制约束。
 * error 有值表示执行失败、无值表示成功。
 *
 * error 尾部 `.optional().transform(v => v ?? undefined)` 与裸 `.optional()` 运行时等价，
 * 差异在类型：该键保持「必填、值可为 ToolError | undefined」，兼容 exactOptionalPropertyTypes
 * （消费方直接赋值即可，无需条件展开）。
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

// ────────── 工具清单（tool:list）：渲染层展示用元数据 ──────────

/**
 * 工具元数据 zod schema
 *
 * tool:list 返回的条目：渲染层据此展示可用工具与权限级别（审批模式设置区按权限分组），
 * 无需感知工具具体实现。
 *
 * 不含 inputSchema——ZodType 不可跨 IPC 序列化，入参校验在主进程做（见
 * src/main/infra/ai/tools/tool.ts 的 Tool.inputSchema）。
 */
export const ToolDescriptorSchema = z.object({
  /** 工具唯一名称（snake_case，如 read_file / write_file） */
  name: z.string().min(1),
  /** 工具描述（LLM 据此决定是否调用，应清晰说明用途） */
  description: z.string().min(1),
  /** 权限级别：'auto' 免审批 / 'ask' 需用户审批（清单来自工具声明，不会出现 'deny'） */
  permission: ToolPermissionSchema,
});

/** 工具元数据 TypeScript 类型（z.infer 派生） */
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/**
 * tool:list 请求 payload：列出当前已注册的工具清单
 *
 * 消费方为审批模式设置区的工具清单（src/renderer/lib/settings-ops.ts 的 listTools）。
 *
 * permission 过滤可选：省略则列出全部工具，传 'auto' / 'ask' 按工具声明精确过滤；
 * 传 'deny' 视同不过滤（工具自身只会声明 'auto' / 'ask'，见 src/main/ipc/tool.handler.ts）。
 *
 * 注意：Req 类型 `ToolListReq` 在 packages/shared/src/ipc/payloads.ts 中通过 z.infer 派生，
 * 与其他域（agent/file/search/...）的惯例保持一致，避免类型多处定义冲突。
 */
export const ToolListReqSchema = z.object({
  /** 权限过滤（省略或 'deny' = 全部工具） */
  permission: ToolPermissionSchema.optional().transform((v) => v ?? undefined),
});

/**
 * tool:list 响应 payload：工具元数据清单
 *
 * 排序由主进程 ToolRegistry.list 保证（name 字母序），渲染层可直接按序渲染。
 */
export interface ToolListRes {
  /** 工具元数据清单（按 name 字母序） */
  readonly tools: readonly ToolDescriptor[];
}

/** tool:list 响应 zod schema（主进程用它校验 handler 返回值防接口漂移；缺失会被 register 拒绝注册） */
export const ToolListResSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
});
