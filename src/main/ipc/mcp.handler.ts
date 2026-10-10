import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { IMCPService } from '../infra/ai/mcp';
import { validateMcpServerConfig } from '../infra/ai/mcp';
import type { IToolRegistry } from '../infra/ai/tools/tool-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * MCP handler 工厂
 *
 * @param mcpService MCP 服务实例（ServiceContainer.getMcpService()）
 * @param toolRegistry 工具注册表（启动前重名校验用）
 */
export function createMcpHandlers(
  mcpService: IMCPService,
  toolRegistry: IToolRegistry,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['mcp'] {
  return {
    list: async () => {
      const servers = mcpService.listServers();
      return { servers };
    },

    start: async (input) => {
      const { name, transport, url, headers, command, args } = input;
      validateMcpServerConfig(
        {
          name,
          ...(transport !== undefined ? { transport } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(headers !== undefined ? { headers } : {}),
          command,
          ...(args !== undefined ? { args } : {}),
        },
        toolRegistry.getAllNames(),
      );
      await mcpService.startServer({
        name,
        ...(transport !== undefined ? { transport } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(headers !== undefined ? { headers } : {}),
        command,
        ...(args !== undefined ? { args } : {}),
      });
      return { ok: true };
    },

    stop: async (input) => {
      await mcpService.stopServer(input.name);
      return { ok: true };
    },
  };
}
