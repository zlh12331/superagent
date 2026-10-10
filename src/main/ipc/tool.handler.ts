// tool.handler.ts：tool 域 IPC——工具清单（渲染层工具列表/权限说明消费，permission 过滤可选）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IToolRegistry } from '../infra/ai/tools/tool-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 toolRegistry */
export interface ToolHandlerDeps {
  readonly toolRegistry: IToolRegistry;
}

/** 依赖注入工厂 */
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
