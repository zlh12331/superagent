// src/main/ipc/tool.handler.ts
// 工具域 IPC handler（ToolRegistry 暴露给渲染层的入口，定义表驱动）
//
// 实现 1 个请求-响应方法：
// - list  列出当前已注册的工具清单（含权限级别，供渲染层展示工具面板）
//
// 设计要点：
// - DI 模式：通过 deps 注入 IToolRegistry 实例
// - 工具元数据（ToolDescriptor）由 ToolRegistry.list() 返回，handler 仅做转发
// - 渲染层启动时调用一次 tool:list，获取可用工具列表展示工具面板

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IToolRegistry } from '../infra/ai/tool-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 工具域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 ToolRegistry 实现：
 * - 生产环境：ServiceContainer 注入默认 ToolRegistry 实例（已注册内置工具）
 * - 测试环境：可注入 mock 实现，不依赖真实工具注册
 */
export interface ToolHandlerDeps {
  /** ToolRegistry 实例（由 ServiceContainer 注入） */
  readonly toolRegistry: IToolRegistry;
}

/**
 * 创建工具域 handler 实现
 *
 * @param deps 依赖项：包含 IToolRegistry 实例
 */
export function createToolHandlers(
  deps: ToolHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['tool'] {
  const { toolRegistry } = deps;

  return {
    // 列出工具清单：渲染层启动时调用一次，展示工具面板
    // permission 过滤可选：省略列出全部工具，传 'auto' / 'ask' 仅列出对应权限的工具
    // 'deny' 是决策结果（非工具静态属性），过滤时视为列出全部
    // 返回 tools 数组（按 name 字母序排序，由 ToolRegistry.list 保证）
    list: async (input) => {
      const tools = toolRegistry.list(input.permission === 'deny' ? undefined : input.permission);
      return { tools };
    },
  };
}
