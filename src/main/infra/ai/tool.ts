// src/main/infra/ai/tool.ts
// Tool 接口与执行上下文（Code Agent 工具系统核心抽象）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 Tool 接口：扩展 AI SDK v7 原生 tool 概念，附加 permission 元数据
// - 定义 ToolContext：工具执行时所需的环境信息
// - 定义 ToolResult：工具执行的标准化返回结构
//
// 设计原则：
// - Tool 接口是工具系统的核心抽象，所有具体工具都实现此接口
// - permission 字段与用户决策对齐：白名单自动 + 危险询问
// - inputSchema 使用 ZodType，运行时校验 LLM 生成的入参
// - execute 函数返回 ToolResult，统一 title / output / metadata 结构
//
// 与 AI SDK v7 的关系：
// - AI SDK 原生 tool({ description, inputSchema, execute }) 返回 Tool 对象
// - 本 Tool 接口扩展了 permission 字段，ToolRegistry.toAISDKTools()
//   会将本接口转换为 AI SDK 原生 tool 格式
// - ToolResult.output 会作为 AI SDK tool.execute 的返回值（给 LLM 看）
// ──────────────────────────────────────────────────────────────

import type { WebContents } from 'electron';
import type { ZodType } from 'zod';

/**
 * 工具执行上下文（每次工具调用时构造）
 *
 * - workingDir：工作目录约束，所有文件操作工具必须限制在此目录内
 * - sessionId：当前 agent 对话的 id，用于日志追踪与审批关联
 * - messageId：关联的消息 id，用于定位工具调用属于哪条消息
 * - callId：工具调用 id（同 AI SDK 的 toolCallId），用于事件关联
 * - abortSignal：中断信号，工具执行过程中应定期检查
 * - webContents：接收工具事件的渲染窗口（用于推送终端输出等实时事件）
 * - metadata：可选回调，工具执行中可更新元数据（如进度、子任务状态），
 *   渲染层可据此实时展示工具执行详情
 */
export interface ToolContext {
  /** 工作目录（绝对路径，所有文件操作工具的根目录约束） */
  readonly workingDir: string;
  /** 当前 agent 对话的 sessionId */
  readonly sessionId: string;
  /** 关联的消息 id（工具调用属于哪条 assistant 消息） */
  readonly messageId: string;
  /** 工具调用 id（同 AI SDK 的 toolCallId） */
  readonly callId: string;
  /** 中断信号（与 AgentService 的 AbortController 联动） */
  readonly abortSignal: AbortSignal;
  /**
   * 接收工具事件的渲染窗口（用于推送终端输出等实时事件）
   *
   * 可选：IM 桥接等无头场景不传（推送跳过、审批自动拒绝）。
   */
  readonly webContents?: WebContents;
  /** 元数据更新回调（工具执行中可调用，用于实时展示进度/状态） */
  readonly metadata?: (data: Record<string, unknown>) => void;
  /** Agent 运行模式（缺省视为 'build'：plan 只读探索 / build 审批后执行） */
  readonly mode?: 'plan' | 'build';
  /** 用户原始 prompt（权限决策用：意图豁免破坏性拦截；由 agent-service 从消息历史提取） */
  readonly userPrompt?: string;
}

/**
 * 工具执行结果（标准化返回结构）
 *
 * 参考 MiMo-Code 的 ExecuteResult 设计，统一所有工具的返回格式：
 * - title：UI 展示的人类可读标题
 * - output：给 LLM 看的文本输出（作为 tool result 返回给模型）
 * - metadata：结构化元数据（可选，UI 可解析展示）
 *
 * 为什么要有标准化返回：
 * 1. UI 层可以统一渲染工具结果（title + metadata + output）
 * 2. 方便后续做结果缓存、日志审计、错误分类
 * 3. 与参考项目（MiMo-Code）对齐，便于后续移植更多工具
 */
export interface ToolResult {
  /** 人类可读的标题（UI 展示用，如 "读取文件: src/main.ts"） */
  readonly title: string;
  /** 给 LLM 看的文本输出（作为 tool result 返回给模型） */
  readonly output: string;
  /** 结构化元数据（可选，UI 可解析展示，如文件路径、行数、执行时间等） */
  readonly metadata?: Record<string, unknown>;
}

/**
 * 工具类别（ApprovalMode 决策依据，对齐 qwen 安全白名单语义）
 *
 * - read：只读工具（读文件/搜索/glob），全部模式自动放行
 * - edit：工作区编辑（写文件/编辑/git 操作），auto 模式快速路径放行
 * - exec：命令执行（终端/run_command），auto 模式仍需审批（危险操作）
 */
export type ToolCategory = 'read' | 'edit' | 'exec';

/**
 * Tool 接口：Code Agent 工具系统的核心抽象
 *
 * 与 AI SDK v7 原生 tool 的区别：
 * - 增加 permission 字段：'auto' 白名单自动 / 'ask' 需用户审批
 * - 增加 category 字段：工具类别（ApprovalMode 分级决策依据）
 * - execute 接收 ToolContext：提供 workingDir 约束 + abortSignal 中断能力
 * - execute 返回 ToolResult：标准化返回结构（title / output / metadata）
 *
 * 泛型参数：
 * - TInput：工具入参类型（从 inputSchema 派生）
 *
 * 实现示例：
 * ```ts
 * const readFileTool: Tool<ReadFileInput> = {
 *   name: 'read_file',
 *   description: '读取文件内容',
 *   inputSchema: ReadFileInputSchema,
 *   permission: 'auto',
 *   category: 'read',
 *   execute: async (input, ctx) => {
 *     const content = await readFile(path);
 *     return { title: `读取文件: ${input.path}`, output: content };
 *   },
 * };
 * ```
 */
export interface Tool<TInput = unknown> {
  /** 工具唯一名称（snake_case，如 read_file / write_file / run_command） */
  readonly name: string;
  /** 工具描述（LLM 据此决定是否调用，应清晰说明用途与入参含义） */
  readonly description: string;
  /** 入参 zod schema（运行时校验 LLM 生成的入参） */
  readonly inputSchema: ZodType<TInput>;
  /** 权限级别：'auto' 自动执行 / 'ask' 需用户审批 */
  readonly permission: 'auto' | 'ask';
  /** 工具类别（ApprovalMode 分级决策依据：read 只读 / edit 编辑 / exec 执行） */
  readonly category: ToolCategory;
  /**
   * 执行方法：接收已校验的入参与执行上下文，返回标准化 ToolResult
   *
   * 实现要求：
   * - 应在耗时操作前检查 ctx.abortSignal.aborted，避免中断后继续执行
   * - 文件操作工具应校验路径在 ctx.workingDir 内，防止越权
   * - 抛出的错误会被 ToolExecutor 捕获并转换为错误 ToolResult
   *
   * 使用方法声明（而非函数属性）以支持双变（bivariant）：
   * 工具注册表需要存储异构 Tool<TInput> 集合（类型擦除为 Tool<unknown>），
   * 方法声明允许 Tool<SpecificInput, ...> 赋值给 Tool<unknown, ...>，
   * 而函数属性在 strictFunctionTypes 下是逆变的，无法赋值。
   */
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
