// src/main/infra/agent/tool.ts
// Tool 接口与执行上下文（Code Agent 工具系统核心抽象）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 Tool 接口：扩展 AI SDK v7 原生 tool 概念，附加 permission 元数据
// - 定义 ToolContext：工具执行时所需的环境信息（workingDir / sessionId / abortSignal）
// - 定义 ToolHandler：工具执行函数的签名契约
//
// 设计原则：
// - Tool 接口是工具系统的核心抽象，所有具体工具（read_file / write_file / ...）
//   都实现此接口
// - permission 字段与用户决策对齐：白名单自动 + 危险询问
// - inputSchema 使用 ZodType，运行时校验 LLM 生成的入参
// - execute 函数接收 ToolContext，提供工作目录约束与中断能力
//
// 与 AI SDK v7 的关系：
// - AI SDK 原生 tool({ description, inputSchema, execute }) 返回 Tool 对象
// - 本 Tool 接口扩展了 permission 字段，ToolRegistry.toAISDKTools()
//   会将本接口转换为 AI SDK 原生 tool 格式
// ──────────────────────────────────────────────────────────────

import type { ZodType } from 'zod';

/**
 * 工具执行上下文（每次工具调用时构造）
 *
 * - workingDir：工作目录约束，所有文件操作工具必须限制在此目录内，
 *   防止 Agent 越权读写工作目录之外的文件
 * - sessionId：当前 agent 对话的 id，用于日志追踪与审批关联
 * - abortSignal：中断信号，工具执行过程中应定期检查，
 *   避免用户中断后工具继续执行耗时操作
 */
export interface ToolContext {
  /** 工作目录（绝对路径，所有文件操作工具的根目录约束） */
  readonly workingDir: string;
  /** 当前 agent 对话的 sessionId */
  readonly sessionId: string;
  /** 中断信号（与 AgentService 的 AbortController 联动） */
  readonly abortSignal: AbortSignal;
}

/**
 * Tool 接口：Code Agent 工具系统的核心抽象
 *
 * 与 AI SDK v7 原生 tool 的区别：
 * - 增加 permission 字段：'auto' 白名单自动 / 'ask' 需用户审批
 * - execute 接收 ToolContext：提供 workingDir 约束 + abortSignal 中断能力
 *
 * 泛型参数：
 * - TInput：工具入参类型（从 inputSchema 派生）
 * - TOutput：工具输出类型（execute 返回值类型）
 *
 * 实现示例：
 * ```ts
 * const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
 *   name: 'read_file',
 *   description: '读取文件内容',
 *   inputSchema: ReadFileInputSchema,
 *   permission: 'auto',
 *   execute: async (input, ctx) => { ... },
 * };
 * ```
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** 工具唯一名称（snake_case，如 read_file / write_file / run_command） */
  readonly name: string;
  /** 工具描述（LLM 据此决定是否调用，应清晰说明用途与入参含义） */
  readonly description: string;
  /** 入参 zod schema（运行时校验 LLM 生成的入参） */
  readonly inputSchema: ZodType<TInput>;
  /** 权限级别：'auto' 自动执行 / 'ask' 需用户审批 */
  readonly permission: 'auto' | 'ask';
  /**
   * 执行方法：接收已校验的入参与执行上下文，返回工具输出
   *
   * 实现要求：
   * - 应在耗时操作前检查 ctx.abortSignal.aborted，避免中断后继续执行
   * - 文件操作工具应校验路径在 ctx.workingDir 内，防止越权
   * - 抛出的错误会被 ToolExecutor 捕获并转换为 ToolResult.error
   *
   * 使用方法声明（而非函数属性）以支持双变（bivariant）：
   * 工具注册表需要存储异构 Tool<TInput, TOutput> 集合（类型擦除为 Tool<unknown, unknown>），
   * 方法声明允许 Tool<SpecificInput, ...> 赋值给 Tool<unknown, ...>，
   * 而函数属性在 strictFunctionTypes 下是逆变的，无法赋值。
   */
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}
