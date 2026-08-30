// packages/shared/src/schemas/mcp.ts
// MCP 域 zod schema（MCP 服务器管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 mcp:list / mcp:start / mcp:stop 请求-响应 schema
// - McpServerConfig 与主进程 mcp-types 对齐（name/transport/url/headers/command/args）
// - transport 三态：stdio（本地子进程）/ sse / streamable-http（远程 HTTP）
// - McpServerInfo 由主进程 listServers() 返回，前端仅透传展示
//
// 安全策略（P0，2026-08 安全审计）：
// - command 仅允许裸可执行文件名（MCP_COMMAND_PATTERN）
// - args 额外过 exec-trampoline deny-list（detectMcpExecTrampoline）：
//   shell/解释器 + `-c|-e|/c|/k|-Command` 之类代码串开关一律拒绝
// - 定位澄清：用户亲手配置的 MCP server 仍是"用户信任的提权面"（可读写工作区、
//   起子进程），本 deny-list 是配置文件注入的绊线，不是沙箱
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

/**
 * Shell / 解释器命令集合（stdio MCP server 的 exec trampoline 候选面）
 *
 * 这些命令本身不是 MCP server，只有在配合"脚本参数"时才有意义
 * （`node build/index.js` / `python server.py`）。与下面的"代码串开关"
 * 组合时，args 成为任意代码入口——MCP_COMMAND_PATTERN 只约束 command
 * token（无分隔符/空白），对 args 无效，因此必须在 schema 层补 deny-list。
 */
export const MCP_TRAMPOLINE_COMMANDS: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'bun',
  'cmd',
  'csh',
  'dash',
  'deno',
  'expect',
  'fish',
  'groovy',
  'jshell',
  'ksh',
  'lua',
  'node',
  'osascript',
  'perl',
  'php',
  'powershell',
  'pwsh',
  'pypy',
  'pypy3',
  'python',
  'python2',
  'python3',
  'ruby',
  'sh',
  'tclsh',
  'zsh',
]);

/** 交互式 shell 子集：无参数时从 stdin 读命令（stdio 传输的 stdin 正是协议通道） */
const MCP_INTERACTIVE_SHELLS: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'cmd',
  'csh',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'pwsh',
  'sh',
  'zsh',
]);

/** "把紧随其后的参数当代码执行"的开关（POSIX 与 Windows 常见写法） */
const MCP_TRAMPOLINE_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '-command',
  '-e',
  '-encodedcommand',
  '-eval',
  '-exec',
  '-r',
  '/c',
  '/command',
  '/enc',
  '/e',
  '/exec',
  '/k',
  '--command',
  '--eval',
  '--input-string',
]);

/**
 * 检测 stdio MCP 配置是否为「解释器 + 代码串」执行跳板
 *
 * 命中即应拒绝：
 * - 解释器/shell + 代码串开关（bash -c "curl … | sh" / node -e / cmd /k / powershell -EncodedCommand）
 * - 裸交互式 shell（无脚本参数：stdin 就是命令入口）
 *
 * 刻意不做的事：MCP server 由用户亲手配置，属"用户信任的提权面"（能读工作区、
 * 能起子进程）。本 deny-list 是**配置文件注入的绊线**（恶意 mcp.json / 渲染层
 * 被劫持时塞进 `bash -c`），不是沙箱——真要沙箱得靠容器/权限隔离。
 *
 * @returns 命中原因（未命中返回 null）
 */
export function detectMcpExecTrampoline(
  command: string,
  args: readonly string[] | undefined,
): string | null {
  const name = command
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (!MCP_TRAMPOLINE_COMMANDS.has(name)) {
    return null;
  }
  const list = args ?? [];
  for (const arg of list) {
    const flag = arg.trim().toLowerCase();
    if (MCP_TRAMPOLINE_FLAGS.has(flag)) {
      return `${name} ${flag} 会把后续参数当作代码执行`;
    }
  }
  if (MCP_INTERACTIVE_SHELLS.has(name) && list.length === 0) {
    return `${name} 无脚本参数（交互式 shell，stdin 即命令入口）`;
  }
  return null;
}

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
      } else {
        // P0 安全：args 不受 MCP_COMMAND_PATTERN 约束，解释器 + 代码串开关
        // （bash -c / node -e / cmd /c）等价于任意代码执行——schema 层绊线拦截
        const trampoline = detectMcpExecTrampoline(cfg.command, cfg.args);
        if (trampoline !== null) {
          ctx.addIssue({
            code: 'custom',
            path: ['args'],
            message: `拒绝执行跳板配置：${trampoline}。MCP server 应指向脚本/包本身`,
          });
        }
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
