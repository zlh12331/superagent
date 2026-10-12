// tool-registry.ts：工具注册表——name → Tool 映射 + AI SDK 工具集导出（模型侧 schema/执行闭包）
import type { ToolDescriptor } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { type Tool as AITool, tool as defineAITool } from 'ai';
import { logger } from '../../../utils/logger';
import type { Tool, ToolContext } from './tool';

/** 工具注册表契约（容器构造期 registerBuiltinTools / MCP 运行时注册共用） */
export interface IToolRegistry {
  register(tool: Tool): void;

  unregister(name: string): boolean;

  get(name: string): Tool | undefined;

  getAllNames(): ReadonlySet<string>;

  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[];

  toAISDKTools(
    baseCtx: Omit<ToolContext, 'messageId' | 'callId' | 'metadata'>,
    executeHook?: (tool: Tool, input: unknown, ctx: ToolContext) => Promise<unknown>,
  ): Record<string, AITool>;
}

export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(toolInstance: Tool): void {
    if (!toolInstance.name) {
      throw new AppError(ErrorCode.TOOL_NOT_FOUND, '工具名不能为空');
    }

    if (this.tools.has(toolInstance.name)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `工具已注册：${toolInstance.name}`);
    }

    this.tools.set(toolInstance.name, toolInstance);
    logger.info({ toolName: toolInstance.name, permission: toolInstance.permission }, '工具已注册');
  }

  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      logger.info({ toolName: name }, '工具已注销');
    }
    return existed;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAllNames(): ReadonlySet<string> {
    return new Set(this.tools.keys());
  }

  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];
    for (const toolInstance of this.tools.values()) {
      if (permissionFilter !== undefined && toolInstance.permission !== permissionFilter) {
        continue;
      }
      descriptors.push({
        name: toolInstance.name,
        description: toolInstance.description,
        permission: toolInstance.permission,
      });
    }
    descriptors.sort((a, b) => a.name.localeCompare(b.name));
    return descriptors;
  }

  toAISDKTools(
    baseCtx: Omit<ToolContext, 'messageId' | 'callId' | 'metadata'>,
    executeHook?: (tool: Tool, input: unknown, ctx: ToolContext) => Promise<unknown>,
  ): Record<string, AITool> {
    const aiTools: Record<string, AITool> = {};
    for (const toolInstance of this.tools.values()) {
      aiTools[toolInstance.name] = defineAITool({
        description: toolInstance.description,
        inputSchema: toolInstance.inputSchema,
        execute: async (input: unknown, options) => {
          const callId = options.toolCallId;
          const ctx: ToolContext = {
            ...baseCtx,
            messageId: '',
            callId,
          };
          if (executeHook !== undefined) {
            return executeHook(toolInstance, input, ctx);
          }
          const result = await toolInstance.execute(input, ctx);
          return result.output;
        },
      });
    }
    return aiTools;
  }
}
