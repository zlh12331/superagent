// src/main/infra/ai/mcp/index.ts
// MCP 模块 barrel 导出
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一导出 MCP 集成所需的类型、客户端、服务、适配器
// - 供 ServiceContainer / IPC handler / 测试用例按需 import
//
// 模块结构：
// - mcp-types.ts：配置类型 + 命名空间 helper
// - mcp-tool-adapter.ts：MCP tool → 项目内 Tool 适配器
// - mcp-client.ts：单个 MCP server 客户端封装
// - mcp-service.ts：多 server 管理器（注册/注销到 ToolRegistry）
// ──────────────────────────────────────────────────────────────

export { MCPClient } from './mcp-client';
export {
  buildMcpToolName as buildMcpToolNameFromService,
  type IMCPService,
  isMcpToolName,
  MCPService,
  validateMcpServerConfig,
} from './mcp-service';
export {
  adaptMcpTool,
  decideMcpToolPermission,
  type McpCallToolFn,
  type McpToolCallResult,
  type McpToolDescriptor,
  normalizeMcpToolResult,
} from './mcp-tool-adapter';
export {
  buildMcpToolName,
  isMcpTool,
  type McpServerConfig,
  type McpServerInfo,
  type McpServerStatus,
  parseMcpToolName,
} from './mcp-types';
