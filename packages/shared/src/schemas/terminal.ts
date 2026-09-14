// packages/shared/src/schemas/terminal.ts
// 终端域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 terminal:create / input / resize / kill 请求-响应 zod schema
// - 定义 terminal:event:output / terminal:event:exit 流式事件 payload 类型
// - 供主进程 TerminalService 校验入参
//
// 设计：
// - 终端基于 node-pty（已引入），每个终端对应一个 PTY 进程
// - terminalId 是终端会话的唯一标识（UUID），由主进程生成
// - 终端输出含 ANSI 转义序列，渲染层用 xterm.js 直接渲染（不解码）
// - cols/rows 用合理上限防止 OOM（500x200）
// - env 用 z.record 而非 z.object：环境变量键名动态且不固定
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * 渲染层禁止注入的环境变量键（P0 安全）
 *
 * 这些键决定「进程启动后命令/代码从哪里解析」，允许 IPC 侧覆盖等同于
 * 劫持终端内执行的每一条命令（渲染层被 XSS 攻破时即可 RCE）：
 * - PATH / PATHEXT / SYSTEMROOT / WINDIR / COMSPEC：可执行文件与系统行为解析
 * - LD_PRELOAD / LD_LIBRARY_PATH / DYLD_*：动态库加载劫持
 * - NODE_OPTIONS / NODE_PATH / PYTHONPATH / PYTHONHOME / PERL5OPT / RUBYOPT /
 *   JAVA_TOOL_OPTIONS：解释器启动即执行注入代码
 * - PSModulePath / GIT_SSH / GIT_SSH_COMMAND / GIT_CONFIG_GLOBAL / SSH_AUTH_SOCK：
 *   模块与 git/ssh 外联行为重定向
 *
 * 与 terminal-service 的 SENSITIVE_ENV_KEYS 同源（service 保留二次过滤作为兜底）。
 */
export const TERMINAL_ENV_DENY_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PROMPT',
  'PSMODULEPATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'SSH_AUTH_SOCK',
]);

/**
 * 判断环境变量键是否属于禁止注入清单
 *
 * 统一按大写比较：Windows 环境变量本身大小写不敏感（`path` 与 `PATH` 同义），
 * POSIX 侧这些关键变量亦全为大写惯例，故大写归一不会误伤普通自定义变量。
 */
export function isTerminalEnvDenied(key: string): boolean {
  return TERMINAL_ENV_DENY_KEYS.has(key.trim().toUpperCase());
}

/**
 * terminal:create 入参 zod schema
 *
 * command 省略时使用默认 shell：
 * - Windows: PowerShell（process.env.ComSpec 不可用，用 powershell.exe）
 * - macOS/Linux: $SHELL 或 /bin/bash
 *
 * env 可选：传入额外环境变量（与系统 env 合并，覆盖同名系统变量）
 */
export const TerminalCreateReqSchema = z
  .object({
    // 工作目录（P3 修复：可选——省略时主进程回退到用户主目录，
    // 此前渲染层硬编码 DEFAULT_CWD 与激活会话脱钩）
    cwd: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v ?? undefined),
    // 启动命令（省略时用默认 shell）
    command: z
      .string()
      .optional()
      .transform((v) => v ?? undefined),
    // 环境变量（键值对）
    env: z
      .record(z.string(), z.string())
      .optional()
      .transform((v) => v ?? undefined),
    // 终端列数（默认 80，上限 500）
    cols: z.number().int().positive().max(500).default(80),
    // 终端行数（默认 24，上限 200）
    rows: z.number().int().positive().max(200).default(24),
  })
  .superRefine((cfg, ctx) => {
    // P0 收口：渲染层永不传自定义启动命令（终端面板只用默认 shell，实测
    // TerminalPanel 固定传 undefined）。IPC 边界直接拒绝非空 command——
    // 此前 command 按 shell 语义拆词后首 token 即 spawn 的二进制，等于
    // 给渲染层开了「任意进程原语」（且无审批，区别于 agent 侧 ask 工具）。
    // 未来若需"以指定解释器打开终端"，必须走审批链，不允许恢复透传。
    if (cfg.command !== undefined && cfg.command.trim().length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'terminal:create 仅允许默认 shell，不接受自定义启动命令',
      });
    }
    // P0 安全：IPC 边界直接拒绝覆盖系统关键变量（类型化校验错误，
    // 而不是静默丢弃——静默丢弃会让调用方误以为注入生效）
    if (cfg.env === undefined) {
      return;
    }
    const denied = Object.keys(cfg.env).filter(isTerminalEnvDenied);
    if (denied.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: `终端 env 不允许覆盖系统关键环境变量：${denied.join(', ')}`,
      });
    }
  });

/** terminal:create 响应 payload */
export interface TerminalCreateRes {
  /** 终端会话唯一 id（UUID，主进程生成） */
  readonly terminalId: string;
  /** PTY 进程 pid */
  readonly pid: number;
}

/** terminal:create 响应 zod schema（响应契约校验用） */
export const TerminalCreateResSchema = z.object({
  terminalId: z.string().min(1),
  pid: z.number().int().positive(),
});

/**
 * terminal:input 入参 zod schema
 *
 * data 是要写入终端的字符串，可以是用户键入的字符，也可以是粘贴的命令。
 * 主进程通过 node-pty 的 write 方法写入。
 */
export const TerminalInputReqSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});

/** terminal:input 响应 payload */
export interface TerminalInputRes {
  /** 是否成功写入（终端已关闭则返回 false） */
  readonly ok: boolean;
}

/** terminal:input 响应 zod schema（R3：响应契约校验） */
export const TerminalInputResSchema = z.object({
  ok: z.boolean(),
});

/** terminal:resize 入参 zod schema */
export const TerminalResizeReqSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(200),
});

/** terminal:resize 响应 payload */
export interface TerminalResizeRes {
  readonly ok: boolean;
}

/** terminal:resize 响应 zod schema（R3：响应契约校验） */
export const TerminalResizeResSchema = z.object({
  ok: z.boolean(),
});

/** terminal:kill 入参 zod schema */
export const TerminalKillReqSchema = z.object({
  terminalId: z.string().min(1),
});

/** terminal:kill 响应 payload */
export interface TerminalKillRes {
  readonly ok: boolean;
}

/** terminal:kill 响应 zod schema（R3：响应契约校验） */
export const TerminalKillResSchema = z.object({
  ok: z.boolean(),
});

/**
 * terminal:event:output 流式事件 payload
 *
 * 主进程监听 node-pty 的 onData 事件，每次有输出时推送此 payload。
 * data 是原始 ANSI 转义序列字符串，渲染层用 xterm.js 直接 write。
 *
 * 注意：data 可能包含多条 ANSI 命令拼接，渲染层不应拆分。
 */
export interface TerminalOutputEventPayload {
  readonly terminalId: string;
  /** 终端原始输出（含 ANSI 转义序列，未解码） */
  readonly data: string;
}

/**
 * terminal:event:created 流式事件 payload
 *
 * 终端创建成功后推送，用于通知渲染层（包括 Agent 工具创建的终端）。
 * 渲染层收到后可将终端加入终端列表并显示。
 */
export interface TerminalCreatedEventPayload {
  readonly terminalId: string;
  /** 终端标题（启动命令或默认 shell 名） */
  readonly title: string;
  /** 进程 id */
  readonly pid: number;
  /** 工作目录 */
  readonly cwd: string;
  /** 初始列数 */
  readonly cols: number;
  /** 初始行数 */
  readonly rows: number;
}

/**
 * terminal:event:exit 流式事件 payload
 *
 * 终端进程退出时推送（无论正常退出还是被 kill）。
 * exitCode: 0 表示正常退出；非 0 表示异常退出
 * signal: 被信号中断时携带信号名（如 'SIGTERM'）
 */
export interface TerminalExitEventPayload {
  readonly terminalId: string;
  /** 进程退出码（0 正常退出） */
  readonly exitCode: number;
  /** 被信号中断时的信号名（如 'SIGTERM'） */
  readonly signal?: string;
}

// ── 事件 payload zod schema（R2：主进程发送侧 dev 校验，envelope 级） ──

/** terminal:event:output payload schema（data 原样透传，仅 envelope 校验） */
export const TerminalOutputEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});

/** terminal:event:created payload schema */
export const TerminalCreatedEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  title: z.string(),
  pid: z.number().int().positive(),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** terminal:event:exit payload schema */
export const TerminalExitEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  exitCode: z.number().int(),
  signal: z.string().optional(),
});
