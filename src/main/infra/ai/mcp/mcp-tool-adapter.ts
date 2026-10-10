import { AppError, ErrorCode } from '@code-agent/shared/main';
import { jsonSchema } from 'ai';
import type { Tool, ToolContext, ToolResult } from '../tools/tool';
import type { McpServerConfig } from './mcp-types';
import { buildMcpToolName } from './mcp-types';

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
  };
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
    | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
    | {
        readonly type: 'resource';
        readonly resource: { readonly uri: string; readonly text?: string; readonly blob?: string };
      }
  >;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export type McpCallToolFn = (
  toolName: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<McpToolCallResult>;

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

function toAiSdkInputSchema(schema: McpToolDescriptor['inputSchema'] | undefined) {
  type JsonSchemaInput = Parameters<typeof jsonSchema>[0];
  const jsonSchemaValue = (schema ?? { type: 'object' }) as unknown as JsonSchemaInput;
  return jsonSchema(jsonSchemaValue);
}
