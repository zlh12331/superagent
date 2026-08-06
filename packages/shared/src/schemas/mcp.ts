// packages/shared/src/schemas/mcp.ts
// MCP 域 zod schema（MCP 服务器管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 mcp:list / mcp:start / mcp:stop 请求-响应 schema
// - McpServerConfig 与主进程 mcp-types 对齐（name/command/args/env/cwd）
// - McpServerInfo 由主进程 listServers() 返回，前端仅透传展示
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** MCP server 配置 zod schema（与主进程 McpServerConfig 对齐） */
export const McpServerConfigSchema = z.object({
  /** server 唯一名称（工具命名空间前缀 mcp__${name}__${tool}） */
  name: z.string().min(1, 'server 名称不能为空'),
  /** 启动 MCP server 的命令（如 'npx' / 'node'） */
  command: z.string().min(1, 'command 不能为空'),
  /** 命令行参数 */
  args: z
    .array(z.string())
    .optional()
    .transform((v) => v ?? undefined),
});

/** mcp:start 入参类型 */
export type McpStartReq = z.infer<typeof McpServerConfigSchema>;

/** mcp:list 入参（无入参） */
export const McpListReqSchema = z.object({});

/** mcp:stop 入参 */
export const McpStopReqSchema = z.object({
  /** 要停止的 server 名称 */
  name: z.string().min(1),
});

/** MCP server 状态（与主进程 McpServerStatus 对齐） */
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopped_with_error';

/** MCP server 运行时信息（主进程 listServers() 返回值，前端透传展示） */
export interface McpServerInfo {
  /** server 配置 */
  readonly config: {
    readonly name: string;
    readonly command: string;
    readonly args?: readonly string[];
  };
  /** 当前状态 */
  readonly status: McpServerStatus;
  /** 最后一次错误信息（status='error' 时有值） */
  readonly lastError?: string;
  /** 已注册的工具名列表（带 mcp__ 前缀） */
  readonly toolNames: readonly string[];
}

/** mcp:list 响应 */
export interface McpListRes {
  readonly servers: readonly McpServerInfo[];
}

/** mcp:start 响应 */
export interface McpStartRes {
  readonly ok: boolean;
}

/** mcp:stop 响应 */
export interface McpStopRes {
  readonly ok: boolean;
}
