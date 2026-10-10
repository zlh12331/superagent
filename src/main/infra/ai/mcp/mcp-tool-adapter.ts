import { AppError, ErrorCode } from '@code-agent/shared/main';
import { jsonSchema } from 'ai';
import type { Tool, ToolContext, ToolResult } from '../tools/tool';
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
   * 由 `adaptMcpTool` 经 AI SDK `jsonSchema()` 原样透传进工具定义，
   * 模型据此生成参数——因此不可在此处改写或降级其结构。
   * 客户端不做重复校验（MCP server 必须自行 validate）。
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
 * 适配器关心 content 数组（文本/图片/资源等）；structuredContent 经
 * normalizeMcpToolResult 优先返回（若 server 声明了 outputSchema），
 * 元数据以 hasStructuredContent 标记。
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
  if (config.permissionOverride !== undefined) {
    return config.permissionOverride;
  }
  if (annotations?.readOnlyHint === true) {
    return 'auto';
  }
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

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

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
 * - inputSchema：透传 MCP server 的 JSON Schema（经 jsonSchema() 包装），校验由 server 完成
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
    inputSchema: toAiSdkInputSchema(descriptor.inputSchema),
    permission,
    category: 'exec',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.abortSignal.aborted) {
        throw new AppError(ErrorCode.TOOL_ABORTED, `MCP 工具已中断：${namespacedName}`);
      }

      const result = await callTool(descriptor.name, input, ctx);

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
 * MCP inputSchema → AI SDK Schema
 *
 * jsonSchema() 不带 validate 即不做客户端校验（MCP server 是校验真源），
 * 但 schema 本身会原样进入工具定义，模型据此生成参数。
 *
 * descriptor.inputSchema 是 JSON Schema 的只读子集视图，与 JSONSchema7 结构等价，
 * 故此处做一次类型转换而非逐字段重建。
 */
function toAiSdkInputSchema(schema: McpToolDescriptor['inputSchema'] | undefined) {
  type JsonSchemaInput = Parameters<typeof jsonSchema>[0];
  const jsonSchemaValue = (schema ?? { type: 'object' }) as unknown as JsonSchemaInput;
  return jsonSchema(jsonSchemaValue);
}
