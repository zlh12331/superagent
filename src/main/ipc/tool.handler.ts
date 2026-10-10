import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IToolRegistry } from '../infra/ai/tools/tool-registry';
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
    list: async (input) => {
      const tools = toolRegistry.list(input.permission === 'deny' ? undefined : input.permission);
      return { tools };
    },
  };
}
