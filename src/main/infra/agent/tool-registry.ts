// src/main/infra/agent/tool-registry.ts
// 工具注册表：管理工具的注册、查找与转换为 AI SDK 格式
// ──────────────────────────────────────────────────────────────
// 职责：
// - register(tool)：注册工具实例，重名抛错
// - get(name)：按名查找工具实例
// - list()：列出所有工具元数据（ToolDescriptor）
// - toAISDKTools(ctx)：转换为 AI SDK v7 原生 tool 格式（Record<string, AITool>）
//
// 设计原则：
// - 单一注册表：整个应用共享一个 ToolRegistry 实例（通过 ServiceContainer 持有）
// - 注册时校验：避免重名注册导致 LLM 调用错乱
// - 转换时注入 ctx：每次 agent 对话生成独立的 AI SDK tools 集合，
//   闭包捕获对应的 sessionId / workingDir / abortSignal
//
// 与 AI SDK v7 的关系：
// - streamText 接收 tools 参数，类型为 Record<string, Tool>
// - 本注册表的 toAISDKTools() 把项目内 Tool 接口转换为 AI SDK 原生 Tool
// - 转换时包装 execute 函数，注入 ToolContext
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
   * @returns AI SDK 原生 tool 集合，可直接传给 streamText 的 tools 参数
   */
  toAISDKTools(ctx: ToolContext): Record<string, AITool>;
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
  toAISDKTools(ctx: ToolContext): Record<string, AITool> {
    const aiTools: Record<string, AITool> = {};
    for (const toolInstance of this.tools.values()) {
      // 包装 execute 函数，注入 ToolContext
      // 闭包捕获 ctx，每次 streamText 调用生成的 tools 集合是独立的
      aiTools[toolInstance.name] = defineAITool({
        description: toolInstance.description,
        inputSchema: toolInstance.inputSchema,
        execute: async (input: unknown) => {
          // 注意：这里 input 已被 AI SDK 通过 inputSchema 校验过
          // 直接调用原 Tool 接口的 execute
          return toolInstance.execute(input, ctx);
        },
      });
    }
    return aiTools;
  }
}
