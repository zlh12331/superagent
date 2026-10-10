// mcp.ts：MCP 域 zod 契约单一真源——mcp:list / mcp:start / mcp:stop 的请求-响应形状，以及 stdio 命令注入防线（裸可执行文件名 + exec 跳板 deny-list）
// 消费方：IPC 定义表 packages/shared/src/ipc/definitions.ts 的 mcp 域（入参校验 + 响应契约），并经 packages/shared/src/index.ts 与 main.ts 再导出；主进程校验 src/main/infra/ai/mcp/mcp-service.ts 复用其中的字符集常量做纵深防御
// 边界：只定义形状与静态校验——子进程启动、工具注册与运行状态机都在主进程 src/main/infra/ai/mcp/

import { z } from 'zod';

// ─── 校验原语：名称/命令字符集、参数上限与 exec 跳板 deny-list（前两个模式被主进程同源复用） ───

/**
 * MCP server 名称字符集：字母数字开头 + 字母数字/下划线/连字符（1-64 字符）
 *
 * 约束原因：name 是工具命名空间 mcp__${name}__${tool} 的前缀段，其它字符会破坏命名空间解析
 * （命名空间规则见 src/main/infra/ai/mcp/mcp-types.ts 的 buildMcpToolName）；
 * name 同时是 server 的唯一标识（主进程 Map 键与日志字段）。
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * MCP 启动命令约束：仅允许裸可执行文件名（无路径分隔符 / 空白 / 引号）
 *
 * 安全动机（P0）：
 * - 该值经 src/main/infra/ai/mcp/mcp-client.ts 交给 StdioClientTransport 作为子进程命令
 *   （SDK 内部以 shell: false spawn），裸文件名只能命中 PATH 中的可执行文件，阻断
 *   · 绝对路径（C:\... / /usr/bin/...）
 *   · 相对路径穿越（./x、..\x）
 *   · 多段命令（cmd /c ... 的 / 与空格）
 * - 主进程 validateMcpServerConfig 复用同一模式做纵深防御
 */
export const MCP_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 参数个数 / 单个参数长度上限（防御性：异常长、异常多的参数没有合法场景，且会被原样
 * 传给 MCP server 子进程）
 */
export const MCP_MAX_ARGS = 64;
export const MCP_MAX_ARG_LENGTH = 2048;

/**
 * Shell / 解释器命令集合（stdio MCP server 的 exec trampoline 候选面）
 *
 * 这些命令本身不是 MCP server，只有在配合"脚本参数"时才有意义
 * （`node build/index.js` / `python server.py`）。与下面的"代码串开关"
 * 组合时，args 成为任意代码入口——MCP_COMMAND_PATTERN 只约束 command
 * token（无分隔符/空白），对 args 无效，因此必须在 schema 层补 deny-list。
 * 名单只记裸名，Windows 的 'CMD.EXE' 写法由 detectMcpExecTrampoline 归一后比对。
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
 * @param args 省略与空数组等价（都按"无脚本参数"判定交互式 shell）
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

// ─── 传输类型与远程侧原语：transport 三态 / headers 上限 / http(s) URL ───

/**
 * MCP transport 类型（缺省 stdio；向后兼容：旧配置无此字段视为 stdio）
 *
 * - 'stdio'：本地子进程，由 command/args 启动
 * - 'sse'：远程 HTTP 的 SSE 通道
 * - 'streamable-http'：远程 HTTP 的现代传输（两者各自的客户端见 src/main/infra/ai/mcp/mcp-client.ts）
 */
export const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
/** MCP transport 类型（从 MCP_TRANSPORTS 派生，避免字面量维护两处；主进程同名类型与之对齐） */
export type McpTransportType = (typeof MCP_TRANSPORTS)[number];

/** MCP headers 上限（防御性：合法配置只带 Authorization 等少数几个头，16 足够宽松；校验点见下方 superRefine） */
export const MCP_MAX_HEADERS = 16;

/**
 * URL 校验（sse/streamable-http）：仅允许 http(s) 协议（阻断 file:/ftp: 等非 HTTP 场景）
 *
 * @returns 协议为 http/https 时为 true；非 URL 字符串与其它协议一律 false
 */
export function isValidMcpHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── 配置契约：mcp:start 入参（形状 + 按 transport 分支的 superRefine 校验） ───

/**
 * MCP server 配置 zod schema（与主进程 McpServerConfig 对齐）
 *
 * 字段级只约束形状与长度，跨字段语义全在末尾的 superRefine 里按 transport 分支处理：
 * stdio 要 command 非空、字符集合法且不是 exec 跳板；远程要 url 非空且为 http(s)。
 *
 * 归一策略：可选字段缺省一律保持「未设置」而不回填缺省值——「缺 transport 视为 stdio」这类
 * 兜底由下游 resolveMcpTransport 负责，schema 不替调用方预先决定；唯一的例外是 command
 * 缺省归一为空串，好让 stdio 分支的空值判断收敛成一次 `cfg.command.length === 0`。
 */
export const McpServerConfigSchema = z
  .object({
    /** server 唯一名称（工具命名空间前缀 mcp__${name}__${tool}） */
    name: z
      .string()
      .min(1, 'server 名称不能为空')
      .max(64)
      .regex(MCP_SERVER_NAME_PATTERN, 'server 名称仅允许字母/数字/下划线/连字符'),
    /** 传输类型（缺省 stdio；此处不落缺省值，留给 resolveMcpTransport） */
    transport: z
      .enum(MCP_TRANSPORTS)
      .optional()
      .transform((v) => v ?? undefined),
    /** 远程 server URL（sse / streamable-http；协议只 http/https，必填性由 superRefine 判） */
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
    // headers 数量只能在此校验：zod v4 的 record 无长度方法，字段级写不出来
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
        // args 不受 MCP_COMMAND_PATTERN 约束（它只约束 command token），故此处必须补跳板 deny-list
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
    // 远程 transport：url 必填 + http(s) 校验（stdio 分支在此前已 return）
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

// ─── mcp 域三个方法的入参契约 ───

/**
 * mcp:start 入参类型（z.infer = 校验后的 output 形状：transform 已应用，command 是归一后的 string）
 *
 * 注意方向：这是 handler 侧收到的形状。渲染层发送走 z.input（见 packages/shared/src/ipc/derive.ts
 * 的 ReqOf）——可选字段可以不传，故不要按本类型反向构造请求体。
 */
export type McpStartReq = z.infer<typeof McpServerConfigSchema>;

/** mcp:list 入参（无入参；schema 仍要求传空对象 `{}`——注册层只对 schema=null 的方法接受 undefined） */
export const McpListReqSchema = z.object({});

/** mcp:stop 入参 */
export const McpStopReqSchema = z.object({
  /** 要停止的 server 名称（指向 mcp:start 建过的同一 server；此处只做非空校验——停止未运行的 server 是幂等空操作，无需复用名称字符集） */
  name: z.string().min(1),
});

// ─── 运行时信息与响应契约（mcp:list 的返回形状） ───

/**
 * MCP server 状态（与主进程 McpServerStatus 对齐；值域必须同步，否则 mcp:list 响应校验会拒真）
 *
 * - 'stopped'：已停止（正常关闭）
 * - 'starting'：已建条目、正在握手与注册工具
 * - 'running'：握手完成，工具已注册
 * - 'error'：启动失败（lastError 有值）
 * - 'stopped_with_error'：停止时进程关闭报错，或停止一个本就处于 error 的 server（渲染层按"已停但有错"
 *   显示警示色，与 'error' 的"启动失败待处理"区分）
 *
 * 两个 stopped* 值只在 src/main/infra/ai/mcp/mcp-service.ts 的 stopServer 中赋值，而该函数随即将条目
 * 从 listServers 的源 Map 中移除——因此它们服务于类型完备与渲染层徽章配色，实际不会出现在 mcp:list 结果里。
 */
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopped_with_error';

/**
 * MCP server 运行时信息（主进程 listServers() 返回值，前端透传展示）
 *
 * config 是展示用的窄化子集：主进程 McpServerConfig 还带 env / cwd / permissionOverride，
 * 本接口刻意不列（响应经 McpListResSchema 校验时未知键会被 zod 剥离）。
 */
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
    /** 命令行参数（stdio） */
    readonly args?: readonly string[];
  };
  /** 当前状态 */
  readonly status: McpServerStatus;
  /** 最后一次错误信息（'error'/'stopped_with_error' 时有值；渲染层按非空判断后逐字展示） */
  readonly lastError?: string;
  /** 已注册的工具名列表（带 mcp__ 前缀；运行中才有值，停止时清单先被清空再移出列表） */
  readonly toolNames: readonly string[];
}

/** mcp:list 响应 */
export interface McpListRes {
  readonly servers: readonly McpServerInfo[];
}

/**
 * mcp:list 响应 zod schema（R3 契约校验：handler 返回值回渲染层前必过）
 *
 * config 刻意用宽松形状而非 McpServerInfo['config']：主进程 McpServerConfig 还带 env/cwd/
 * permissionOverride，zod 对象默认剥离未知键，这里正是把展示子集筛出来的地方（响应因此比
 * 上面 interface 少这几个字段，二者不必逐字段等同）。
 */
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

/** mcp:start 响应（定义表用共享的 OkResSchema 做运行时校验，本接口只供类型引用） */
export interface McpStartRes {
  readonly ok: boolean;
}

/** mcp:stop 响应（同 mcp:start：仅类型引用，运行时校验走 OkResSchema） */
export interface McpStopRes {
  readonly ok: boolean;
}
