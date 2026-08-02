// src/main/infra/ai/mcp/mcp-tool-adapter.ts
// MCP 工具适配器：把 MCP server 的工具转换为项目内 Tool 接口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 把 MCP SDK 的 Tool（JSON Schema 描述）转换为项目内 Tool 接口
// - 通过 MCP Client 转发工具调用，并把结果转换为统一格式
// - 决定 permission：基于 annotations.readOnlyHint 或用户配置覆盖
//
// 设计原则：
// - 适配器不持有 MCP Client 引用（避免生命周期耦合），通过 callTool 回调注入
// - inputSchema 用宽松 Zod schema（z.record(z.string(), z.unknown())），
//   实际入参校验由 MCP server 自行完成（MCP 协议规定 server 必须 validate input）
// - 工具名加命名空间前缀（mcp__${serverName}__${toolName}），避免与内置工具重名
// - 工具描述透传 server 返回的 description，让 LLM 据此决定是否调用
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tool';
import type { McpServerConfig } from './mcp-types';
import { buildMcpToolName } from './mcp-types';

/**
 * MCP server 返回的工具元数据（listTools 结果元素）
 *
 * 与 @modelcontextprotocol/sdk 的 listTools 返回结构对齐，
 * 仅保留适配器需要的字段（inputSchema / description / annotations）。
 */
export interface McpToolDescriptor {
  /** 工具名（不含命名空间前缀，由 MCP server 返回） */
  readonly name: string;
  /** 工具描述（LLM 据此决定是否调用） */
  readonly description?: string;
  /**
   * 入参 JSON Schema（MCP 协议规定）
   *
   * 适配器不会用此 schema 在客户端做严格校验（MCP server 自行校验），
   * 仅作为元数据透传给 AI SDK。
   */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
  };
  /**
   * 工具注解（MCP 协议规定）
   *
   * - readOnlyHint：只读工具，可设 permission='auto'
   * - destructiveHint：破坏性操作（如删除文件），应 permission='ask'
   * - idempotentHint：幂等操作（重复调用结果一致）
   * - openWorldHint：与外部世界交互（如网络请求）
   */
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/**
 * MCP 工具调用结果（callTool 返回）
 *
 * 与 @modelcontextprotocol/sdk 的 callTool 返回结构对齐。
 * 适配器只关心 content 数组（文本/图片/资源等），structuredContent 留待后续迭代。
 */
export interface McpToolCallResult {
  /** 内容数组（可能包含 text / image / audio / resource 等类型） */
  readonly content: ReadonlyArray<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
    | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
    | {
        readonly type: 'resource';
        readonly resource: { readonly uri: string; readonly text?: string; readonly blob?: string };
      }
  >;
  /** 结构化输出（若 server 声明了 outputSchema） */
  readonly structuredContent?: unknown;
  /** 是否错误（server 端执行失败） */
  readonly isError?: boolean;
}

/**
 * MCP 工具调用函数签名（由 MCPClient 注入）
 *
 * 适配器不持有 MCPClient 引用，通过此回调解耦。
 * MCPClient 实现 callTool 时转发到 MCP SDK 的 client.callTool。
 *
 * @param toolName MCP 工具名（不含命名空间前缀）
 * @param input 工具入参（已由 LLM 生成，结构由 MCP server 校验）
 * @param ctx 工具执行上下文（提供 abortSignal，用于中断长时间运行的 MCP 工具）
 * @returns MCP server 返回的工具结果
 */
export type McpCallToolFn = (
  toolName: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<McpToolCallResult>;

/**
 * 决定 MCP 工具的权限级别
 *
 * 决策顺序：
 * 1. config.permissionOverride：用户显式覆盖（优先）
 * 2. annotations.readOnlyHint=true → 'auto'（只读工具自动放行）
 * 3. 默认 'ask'（安全默认，未知工具默认询问）
 *
 * @param config MCP server 配置
 * @param annotations MCP 工具注解（可能为 undefined）
 * @returns 权限级别 'auto' / 'ask'
 */
export function decideMcpToolPermission(
  config: McpServerConfig,
  annotations: McpToolDescriptor['annotations'],
): 'auto' | 'ask' {
  // 1. 用户显式覆盖（优先级最高）
  if (config.permissionOverride !== undefined) {
    return config.permissionOverride;
  }
  // 2. 只读工具自动放行
  if (annotations?.readOnlyHint === true) {
    return 'auto';
  }
  // 3. 安全默认
  return 'ask';
}

/**
 * 把 MCP 工具调用结果转换为项目内 Tool 输出
 *
 * 转换规则：
 * - isError=true → 抛出 AppError(TOOL_EXECUTION_FAILED)
 * - content 数组中的 text 块拼接为一个字符串
 * - 其他类型（image/audio/resource）暂不处理（后续迭代扩展）
 * - structuredContent 直接透传（若存在）
 *
 * @param result MCP server 返回的工具结果
 * @returns 文本拼接（或 structuredContent）
 *
 * @throws AppError(TOOL_EXECUTION_FAILED) 当 server 返回 isError=true
 */
export function normalizeMcpToolResult(result: McpToolCallResult): unknown {
  // server 端错误：抛出 AppError，由 ToolExecutor 捕获转为 ToolResult.error
  if (result.isError) {
    const errorText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new AppError(
      ErrorCode.TOOL_EXECUTION_FAILED,
      `MCP 工具执行失败：${errorText || '未知错误'}`,
    );
  }

  // 优先返回 structuredContent（若 server 声明了 outputSchema）
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  // 拼接所有 text 块
  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
    // 其他类型（image/audio/resource）暂不处理
  }

  // 单个 text 块 → 直接返回字符串
  // 多个 text 块 → 用换行拼接
  // 无 text 块 → 返回空字符串（避免 undefined 污染下游）
  if (textParts.length === 0) {
    return '';
  }
  if (textParts.length === 1) {
    return textParts[0];
  }
  return textParts.join('\n');
}

/**
 * 把 MCP 工具转换为项目内 Tool 接口
 *
 * 适配后的 Tool：
 * - name：命名空间后的工具名（mcp__${serverName}__${toolName}）
 * - description：透传 MCP server 返回的 description
 * - inputSchema：宽松 Zod schema（z.record(z.string(), z.unknown())），实际校验由 MCP server 完成
 * - permission：基于 annotations.readOnlyHint 或 config.permissionOverride 决定
 * - execute：通过 callTool 回调转发到 MCPClient
 *
 * @param config MCP server 配置（用于命名空间与权限决策）
 * @param descriptor MCP server 返回的工具描述
 * @param callTool 工具调用回调（由 MCPClient 注入）
 * @returns 适配后的项目内 Tool 实例
 */
export function adaptMcpTool(
  config: McpServerConfig,
  descriptor: McpToolDescriptor,
  callTool: McpCallToolFn,
): Tool {
  const namespacedName = buildMcpToolName(config.name, descriptor.name);
  const permission = decideMcpToolPermission(config, descriptor.annotations);
  const description =
    descriptor.description ?? `(MCP tool from ${config.name}: ${descriptor.name})`;

  return {
    name: namespacedName,
    description,
    // 宽松 schema：MCP server 自行校验入参（MCP 协议规定）
    // 用 z.record(z.string(), z.unknown()) 允许任意对象，避免复杂 JSON Schema → Zod 转换
    inputSchema: mcpLooseInputSchema,
    permission,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      // 中断信号检查：MCP 工具执行前先检查是否已中断
      // （MCP SDK 当前不原生支持 abortSignal，这里做软检查）
      if (ctx.abortSignal.aborted) {
        throw new AppError(ErrorCode.TOOL_ABORTED, `MCP 工具已中断：${namespacedName}`);
      }

      // 转发到 MCPClient.callTool（内部调用 MCP SDK 的 client.callTool）
      const result = await callTool(descriptor.name, input, ctx);

      // 标准化结果
      const output = normalizeMcpToolResult(result);

      return {
        title: `MCP 工具: ${namespacedName}`,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        metadata: {
          mcpServer: config.name,
          mcpTool: descriptor.name,
          hasStructuredContent: result.structuredContent !== undefined,
        },
      };
    },
  };
}

/**
 * 宽松入参 schema：允许任意对象（实际校验由 MCP server 完成）
 *
 * 设计权衡：
 * - MCP 工具的 inputSchema 是 JSON Schema，转 Zod 复杂且易出错
 * - MCP 协议规定 server 必须 validate input，客户端重复校验是冗余
 * - 用宽松 schema 让 AI SDK 把 LLM 生成的入参原样传给 server
 *
 * 注意：z.record(z.string(), z.unknown()) 要求顶层是对象；非对象入参会被 AI SDK 拒绝。
 * MCP 协议规定工具入参必须是对象，因此这是合理的约束。
 */
const mcpLooseInputSchema = z.record(z.string(), z.unknown());
