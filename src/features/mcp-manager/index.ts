/**
 * MCP manager feature — MCP 服务器管理界面
 *
 * 负责 MCP 服务器列表展示（状态、工具列表、资源列表）、
 * 工具调用界面（参数表单、返回结果展示）。
 *
 * 连接后端命令: mcp_server_status_list, mcp_server_tool_call
 *
 * 参考源码: prototype.html — 搜索 `mcp`, `mcp-server`
 *
 * 组件实现: Task 20
 */

// 服务器列表（设置抽屉 MCP 分区使用）
export { McpServerList } from './McpServerList'
// 服务器卡片
export { McpServerCard } from './McpServerCard'
// 服务器详情对话框
export { McpServerDetailDialog } from './McpServerDetailDialog'
// 添加服务器对话框
export { AddMcpServerDialog } from './AddMcpServerDialog'
// 工具调用对话框
export { McpToolCallDialog } from './McpToolCallDialog'
// MCP 状态管理 store
export { useMcpStore } from './mcp-store'
export type { McpState } from './mcp-store'
// 服务器列表数据加载 hook
export { useMcpServers } from './useMcpServers'
