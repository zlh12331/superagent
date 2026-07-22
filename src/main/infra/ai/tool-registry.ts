// src/main/infra/ai/tool-registry.ts
// 工具注册表：管理工具的注册、查找与转换为 AI SDK 格式
// ──────────────────────────────────────────────────────────────
// 职责：
// - register(tool)：注册工具实例，重名抛错
// - get(name)：按名查找工具实例
// - list()：列出所有工具元数据（ToolDescriptor）
// - toAISDKTools(ctx, executeHook?)：转换为 AI SDK v7 原生 tool 格式
//
// 设计原则：
// - 单一注册表：整个应用共享一个 ToolRegistry 实例（通过 ServiceContainer 持有）
// - 注册时校验：避免重名注册导致 LLM 调用错乱
// - 转换时注入 ctx：每次 agent 对话生成独立的 AI SDK tools 集合，
//   闭包捕获对应的 sessionId / workingDir / abortSignal
// - executeHook 可选注入：AgentService 传入 ToolExecutor.execute 作为 hook，
//   统一执行权限检查、审批流程与 IPC 事件推送；不传时直接调用 tool.execute
//
// 与 AI SDK v7 的关系：
// - streamText 接收 tools 参数，类型为 Record<string, Tool>
// - 本注册表的 toAISDKTools() 把项目内 Tool 接口转换为 AI SDK 原生 Tool
// - AI SDK execute 函数的 options.toolCallId 会传给 executeHook，
//   用于关联 AGENT_TOOL_CALL / AGENT_TOOL_RESULT 事件
// ──────────────────────────────────────────────────────────────

import type { ToolDescriptor } from '@novel-writer/shared';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { type Tool as AITool, tool as defineAITool } from 'ai';
import { logger } from '../../utils/logger';
import type { Tool, ToolContext } from './tool';

/**
 * ToolRegistry 接口
 *
 * 解耦 AgentService 对具体实现的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实工具注册
 * - 未来扩展：支持动态加载工具插件
 */
export interface IToolRegistry {
  /**
   * 注册工具
   *
   * @param tool 待注册的工具实例
   * @throws AppError(ErrorCode.TOOL_NOT_FOUND) 当工具名为空时
   * @throws AppError(ErrorCode.INVALID_INPUT) 当工具名重复时
   */
  register(tool: Tool): void;

  /**
   * 按名查找工具
   *
   * @param name 工具名称
   * @returns 工具实例；未注册返回 undefined
   */
  get(name: string): Tool | undefined;

  /**
   * 列出所有工具的元数据
   *
   * 用于 IPC tool:list channel，渲染层据此展示工具面板。
   *
   * @param permissionFilter 可选权限过滤（'auto' 仅白名单 / 'ask' 仅需审批 / undefined 全部）
   * @returns 工具元数据清单（按 name 字母序）
   */
  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[];

  /**
   * 转换为 AI SDK v7 原生 tool 格式
   *
   * 为每次 agent 对话生成独立的 AI SDK tools 集合，
   * 闭包捕获对应的 sessionId / workingDir / abortSignal。
   *
   * @param ctx 工具执行上下文（注入到每个工具的 execute 函数）
   * @param executeHook 可选的工具执行 hook（AgentService 注入 ToolExecutor.execute）
   *   - 不传时：直接调用 tool.execute(input, ctx)（用于测试/无权限检查场景）
   *   - 传入时：调用 hook(tool, input, ctx, toolCallId)，由 hook 负责权限检查、
   *     审批流程、IPC 事件推送，并返回工具输出
   * @returns AI SDK 原生 tool 集合，可直接传给 streamText 的 tools 参数
   */
  toAISDKTools(
    ctx: ToolContext,
    executeHook?: (
      tool: Tool,
      input: unknown,
      ctx: ToolContext,
      toolCallId: string,
    ) => Promise<unknown>,
  ): Record<string, AITool>;
}

/**
 * ToolRegistry 默认实现
 *
 * 内部维护 Map<name, Tool>，注册时按名去重。
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
 * 工具注册通常在应用启动时一次性完成（见 bootstrap）。
 */
export class ToolRegistry implements IToolRegistry {
  /** 工具实例 Map：name → Tool */
  private readonly tools = new Map<string, Tool>();

  /** @inheritDoc */
  register(toolInstance: Tool): void {
    // 参数校验：工具名不能为空
    if (!toolInstance.name) {
      throw new AppError(ErrorCode.TOOL_NOT_FOUND, '工具名不能为空');
    }

    // 重名校验
    if (this.tools.has(toolInstance.name)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `工具已注册：${toolInstance.name}`);
    }

    this.tools.set(toolInstance.name, toolInstance);
    logger.info({ toolName: toolInstance.name, permission: toolInstance.permission }, '工具已注册');
  }

  /** @inheritDoc */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** @inheritDoc */
  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];
    for (const toolInstance of this.tools.values()) {
      // 权限过滤
      if (permissionFilter !== undefined && toolInstance.permission !== permissionFilter) {
        continue;
      }
      descriptors.push({
        name: toolInstance.name,
        description: toolInstance.description,
        permission: toolInstance.permission,
      });
    }
    // 按 name 字母序排序，确保跨进程一致
    descriptors.sort((a, b) => a.name.localeCompare(b.name));
    return descriptors;
  }

  /** @inheritDoc */
  toAISDKTools(
    ctx: ToolContext,
    executeHook?: (
      tool: Tool,
      input: unknown,
      ctx: ToolContext,
      toolCallId: string,
    ) => Promise<unknown>,
  ): Record<string, AITool> {
    const aiTools: Record<string, AITool> = {};
    for (const toolInstance of this.tools.values()) {
      // 包装 execute 函数，注入 ToolContext 与 executeHook
      // 闭包捕获 ctx 与 executeHook，每次 streamText 调用生成的 tools 集合是独立的
      aiTools[toolInstance.name] = defineAITool({
        description: toolInstance.description,
        inputSchema: toolInstance.inputSchema,
        execute: async (input: unknown, options: { toolCallId?: string } | undefined) => {
          // AI SDK v7 的 execute 第二个参数为 ToolExecutionOptions，包含 toolCallId
          // 这里用宽松类型避免引入 ai 包内部类型依赖，运行时一定能拿到 options
          const toolCallId = options?.toolCallId ?? '';
          if (executeHook !== undefined) {
            // AgentService 注入了 hook：走权限检查 + 审批 + IPC 推送流程
            // hook 内部调用 ToolExecutor.execute，返回 result.output
            return executeHook(toolInstance, input, ctx, toolCallId);
          }
          // 默认行为：直接调用 tool.execute（用于测试/无权限检查场景）
          // 注意：这里 input 已被 AI SDK 通过 inputSchema 校验过
          return toolInstance.execute(input, ctx);
        },
      });
    }
    return aiTools;
  }
}
