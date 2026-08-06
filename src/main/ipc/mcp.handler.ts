// src/main/ipc/mcp.handler.ts
// MCP 域 IPC handler：MCP 服务器管理（列表/启动/停止）
// ──────────────────────────────────────────────────────────────
// 职责：
// - mcp:list：列出已启动的 MCP server 及运行时状态（listServers）
// - mcp:start：按配置启动 MCP server（startServer，stdio 子进程 + 工具注册）
// - mcp:stop：停止指定 MCP server（stopServer，工具注销 + 子进程关闭）
//
// 依赖：IMCPService（ServiceContainer 持有，首次访问时初始化）
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { IMCPService } from '../infra/ai/mcp';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * MCP handler 工厂
 *
 * @param mcpService MCP 服务实例（ServiceContainer.getMcpService()）
 */
export function createMcpHandlers(
  mcpService: IMCPService,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['mcp'] {
  return {
    // mcp:list - 列出所有已启动的 MCP server 及状态
    list: async () => {
      const servers = mcpService.listServers();
      return { servers };
    },

    // mcp:start - 启动 MCP server（stdio 子进程 + 工具注册）
    start: async (input) => {
      await mcpService.startServer({
        name: input.name,
        command: input.command,
        ...(input.args !== undefined ? { args: input.args } : {}),
      });
      return { ok: true };
    },

    // mcp:stop - 停止 MCP server（工具注销 + 子进程关闭）
    stop: async (input) => {
      await mcpService.stopServer(input.name);
      return { ok: true };
    },
  };
}
