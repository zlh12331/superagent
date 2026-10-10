import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IToolRegistry } from '../infra/ai/tools/tool-registry';
import type { IpcHandlerContext } from '../utils/wrap';

export interface ToolHandlerDeps {
  readonly toolRegistry: IToolRegistry;
}

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
