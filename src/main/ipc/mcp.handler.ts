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
    // mcp:list - 列出所有已启动的 MCP server 及状态
    list: async () => {
      const servers = mcpService.listServers();
      return { servers };
    },

    // mcp:start - 启动 MCP server（stdio 子进程 / sse / streamable-http + 工具注册）
    start: async (input) => {
      // 解构取值（TS4111：包装后的请求类型含索引签名，成员点访问受限）
      const { name, transport, url, headers, command, args } = input;
      // P0 安全：schema 校验之后再做主进程侧配置校验（命令字符集/URL/重名保护）。
      // 此前 validateMcpServerConfig 只被测试引用，生产路径裸奔；现在双重防线。
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

    // mcp:stop - 停止 MCP server（工具注销 + 子进程关闭）
    stop: async (input) => {
      await mcpService.stopServer(input.name);
      return { ok: true };
    },
  };
}
