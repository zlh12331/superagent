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
 * terminal:create 入参 zod schema
 *
 * command 省略时使用默认 shell：
 * - Windows: PowerShell（process.env.ComSpec 不可用，用 powershell.exe）
 * - macOS/Linux: $SHELL 或 /bin/bash
 *
 * env 可选：传入额外环境变量（与系统 env 合并，覆盖同名系统变量）
 */
export const TerminalCreateReqSchema = z.object({
  // 工作目录
  cwd: z.string().min(1),
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
});

/** terminal:create 响应 payload */
export interface TerminalCreateRes {
  /** 终端会话唯一 id（UUID，主进程生成） */
  readonly terminalId: string;
  /** PTY 进程 pid */
  readonly pid: number;
}

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

/** terminal:kill 入参 zod schema */
export const TerminalKillReqSchema = z.object({
  terminalId: z.string().min(1),
});

/** terminal:kill 响应 payload */
export interface TerminalKillRes {
  readonly ok: boolean;
}

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
