// packages/shared/src/schemas/mcp.ts
// MCP 域 zod schema（MCP 服务器管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 mcp:list / mcp:start / mcp:stop 请求-响应 schema
// - McpServerConfig 与主进程 mcp-types 对齐（name/command/args/env/cwd）
// - McpServerInfo 由主进程 listServers() 返回，前端仅透传展示
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * MCP server 名称字符集：字母数字 + 下划线/连字符（1-64 字符）
 * 约束原因：name 用于工具命名空间 mcp__${name}__${tool}，非法字符会破坏命名空间解析。
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * MCP 启动命令约束：仅允许裸可执行文件名（无路径分隔符 / 空白 / 引号）
 *
 * 安全动机（P0 修复）：
 * - 该值会被直接传给 StdioClientTransport 作为子进程命令（无 shell 解析）
 * - 裸文件名只能命中 PATH 中的可执行文件，阻断
 *   · 绝对路径（C:\... / /usr/bin/...）
 *   · 相对路径穿越（./x、..\x）
 *   · 多段命令（cmd /c ... 的 / 与空格）
 * - 主进程 validateMcpServerConfig 复用同一模式做纵深防御
 */
export const MCP_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** MCP 参数上限（防御性：异常长/多的参数没有合法场景） */
export const MCP_MAX_ARGS = 64;
export const MCP_MAX_ARG_LENGTH = 2048;

/** MCP server 配置 zod schema（与主进程 McpServerConfig 对齐） */
export const McpServerConfigSchema = z.object({
  /** server 唯一名称（工具命名空间前缀 mcp__${name}__${tool}） */
  name: z
    .string()
    .min(1, 'server 名称不能为空')
    .max(64)
    .regex(MCP_SERVER_NAME_PATTERN, 'server 名称仅允许字母/数字/下划线/连字符'),
  /** 启动 MCP server 的命令（如 'npx' / 'node'，仅裸可执行文件名） */
  command: z
    .string()
    .min(1, 'command 不能为空')
    .max(128)
    .regex(MCP_COMMAND_PATTERN, 'command 必须是裸可执行文件名（不含路径分隔符/空白/引号）'),
  /** 命令行参数 */
  args: z
    .array(z.string().max(MCP_MAX_ARG_LENGTH))
    .max(MCP_MAX_ARGS)
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

/** mcp:list 响应 zod schema（R3：响应契约校验；config 含 env/cwd 等额外键时 zod 默认剥离） */
export const McpListResSchema = z.object({
  servers: z.array(
    z.object({
      config: z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()).optional(),
      }),
      status: z.enum(['stopped', 'starting', 'running', 'error', 'stopped_with_error']),
      lastError: z.string().optional(),
      toolNames: z.array(z.string()),
    }),
  ),
});

/** mcp:start 响应 */
export interface McpStartRes {
  readonly ok: boolean;
}

/** mcp:stop 响应 */
export interface McpStopRes {
  readonly ok: boolean;
}
