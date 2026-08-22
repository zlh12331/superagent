// packages/shared/src/schemas/mcp.ts
// MCP 域 zod schema（MCP 服务器管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 mcp:list / mcp:start / mcp:stop 请求-响应 schema
// - McpServerConfig 与主进程 mcp-types 对齐（name/transport/url/headers/command/args）
// - transport 三态：stdio（本地子进程）/ sse / streamable-http（远程 HTTP）
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

/** MCP transport 类型（缺省 stdio；向后兼容：旧配置无此字段视为 stdio） */
export const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
export type McpTransportType = (typeof MCP_TRANSPORTS)[number];

/** MCP headers 上限（防御性） */
export const MCP_MAX_HEADERS = 16;

/** URL 校验（sse/streamable-http）：仅允许 http(s) 协议（阻断 file:/ftp: 等非 HTTP 场景） */
export function isValidMcpHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** MCP server 配置 zod schema（与主进程 McpServerConfig 对齐） */
export const McpServerConfigSchema = z
  .object({
    /** server 唯一名称（工具命名空间前缀 mcp__${name}__${tool}） */
    name: z
      .string()
      .min(1, 'server 名称不能为空')
      .max(64)
      .regex(MCP_SERVER_NAME_PATTERN, 'server 名称仅允许字母/数字/下划线/连字符'),
    /** 传输类型（缺省 stdio） */
    transport: z
      .enum(MCP_TRANSPORTS)
      .optional()
      .transform((v) => v ?? undefined),
    /** 远程 server URL（sse / streamable-http 必填；仅 http/https） */
    url: z
      .string()
      .max(2048)
      .optional()
      .transform((v) => v ?? undefined),
    /** HTTP 请求头（如 Authorization；仅远程 transport 生效） */
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * 启动 MCP server 的命令（如 'npx' / 'node'，仅裸可执行文件名）
     * 仅 stdio 需要；字段级只做长度约束，字符集校验按 transport 在 superRefine 中执行。
     * 缺省归一为空串（远程传输无需携带）
     */
    command: z
      .string()
      .max(128)
      .optional()
      .transform((v) => v ?? ''),
    /** 命令行参数（仅 stdio） */
    args: z
      .array(z.string().max(MCP_MAX_ARG_LENGTH))
      .max(MCP_MAX_ARGS)
      .optional()
      .transform((v) => v ?? undefined),
  })
  .superRefine((cfg, ctx) => {
    // headers 数量防御性上限（zod v4 record 无 .max，在 refine 中校验）
    if (cfg.headers !== undefined && Object.keys(cfg.headers).length > MCP_MAX_HEADERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `headers 最多 ${MCP_MAX_HEADERS} 项`,
      });
    }
    const transport = cfg.transport ?? 'stdio';
    if (transport === 'stdio') {
      if (cfg.command.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'command 不能为空',
        });
      } else if (!MCP_COMMAND_PATTERN.test(cfg.command)) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'command 必须是裸可执行文件名（不含路径分隔符/空白/引号）',
        });
      }
      return;
    }
    // 远程 transport：url 必填 + http(s) 校验
    if (cfg.url === undefined || cfg.url.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: `${transport} 传输需要提供 url` });
    } else if (!isValidMcpHttpUrl(cfg.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'url 必须是合法的 http(s) 地址',
      });
    }
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
    /** 传输类型（缺省 stdio） */
    readonly transport?: McpTransportType;
    /** 远程 server URL（sse / streamable-http） */
    readonly url?: string;
    /** 启动命令（stdio；远程传输缺省） */
    readonly command?: string;
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
        transport: z.enum(MCP_TRANSPORTS).optional(),
        url: z.string().optional(),
        command: z.string().optional(),
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
