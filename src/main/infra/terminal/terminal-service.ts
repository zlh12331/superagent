// src/main/infra/terminal/terminal-service.ts
// TerminalService：基于 node-pty 的终端会话池
// ──────────────────────────────────────────────────────────────
// 职责：
// - create：spawn 一个 PTY 进程（shell），返回 terminalId
// - input：向指定终端写入数据（用户键入 / 粘贴命令）
// - resize：调整终端尺寸（cols/rows）
// - kill：终止指定终端进程
// - dispose：应用退出时统一 kill 所有 PTY（释放子进程句柄）
//
// 设计：
// - 基于 node-pty（已引入，native 模块，@electron/rebuild 已配置）
// - 每个 terminalId 对应一个 IPty 实例 + WebContents（事件推送目标）
// - 终端输出含 ANSI 转义序列，原样推送到渲染层由 xterm.js 渲染（不解码）
// - 事件推送通过 webContents.send，与 FileService watch 事件一致
// - 单例模式：与 FileService / SearchService 一致，便于统一生命周期管理
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import type {
  TerminalCreatedEventPayload,
  TerminalCreateRes,
  TerminalExitEventPayload,
  TerminalInputRes,
  TerminalKillRes,
  TerminalOutputEventPayload,
  TerminalResizeRes,
} from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  IPC_DEFINITIONS,
  TERMINAL_ENV_DENY_KEYS,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { type IPty, spawn } from 'node-pty';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/**
 * create 方法入参
 *
 * 与 TerminalCreateReqSchema 字段对齐，类型独立定义以便测试 mock。
 * webContents 由 IPC handler 注入（ctx.sender），用于推送终端事件。
 */
export interface TerminalCreateOptions {
  /** 工作目录（绝对路径；P3 修复：可选属性——未提供时回退用户主目录） */
  readonly cwd?: string;
  /** 启动命令（省略时用默认 shell） */
  readonly command: string | undefined;
  /** 额外环境变量（与系统 env 合并，覆盖同名系统变量） */
  readonly env: Record<string, string> | undefined;
  /** 终端列数 */
  readonly cols: number;
  /** 终端行数 */
  readonly rows: number;
  /** 接收终端事件的 webContents */
  readonly webContents: WebContents;
}

/**
 * TerminalService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 node-pty
 * - 未来扩展：替换为其他 PTY 实现（如内置 SSH 客户端）
 */
export interface ITerminalService {
  /** 创建终端会话，返回 terminalId */
  create(options: TerminalCreateOptions): Promise<TerminalCreateRes>;
  /** 向终端写入数据 */
  input(terminalId: string, data: string): Promise<TerminalInputRes>;
  /** 调整终端尺寸 */
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResizeRes>;
  /** 终止指定终端 */
  kill(terminalId: string): Promise<TerminalKillRes>;
  /** 获取终端历史输出（从创建开始的所有输出，含 ANSI 转义序列） */
  getOutput(terminalId: string): string;
  /** 清空终端输出缓冲 */
  clearOutput(terminalId: string): void;
  /** 优雅关闭：kill 所有活跃 PTY */
  dispose(): Promise<void>;
}

// ── 禁止渲染层覆盖的系统关键环境变量（P0 安全，兜底过滤）──────────────
// 单一真源在共享层 schemas/terminal.ts（TERMINAL_ENV_DENY_KEYS / isTerminalEnvDenied）：
// IPC schema 已在边界直接拒绝这类 env（类型化校验错误），create() 内保留二次过滤，
// 防止绕过 IPC 的内部调用方（工具/桥接）把劫持变量传进 PTY。
// PATH / PATHEXT 决定可执行文件解析；LD_PRELOAD / NODE_OPTIONS 等决定
// 「进程一启动就加载哪里的代码」，同属命令劫持面。
// ──────────────────────────────────────────────────────────────

/** 输出缓冲最大字节数（环形截断，避免内存膨胀） */
const MAX_BUFFER_BYTES = 100 * 1024;

/**
 * TerminalService 默认实现
 *
 * 内部维护 terminalId → { pty, webContents, outputBuffer } 映射。
 * 每个 PTY 独立关联一个 webContents，避免多窗口事件串扰。
 * outputBuffer 累积终端输出，供工具读取历史内容。
 *
 * 错误分类：
 * - spawn 失败：TERMINAL_SPAWN_FAILED（如 shell 不存在、权限不足）
 * - input/resize/kill 失败：返回 ok=false（不抛错，渲染层据此判断终端已关闭）
 */
export class TerminalService implements ITerminalService {
  /**
   * PTY 创建函数（DI 注入点：测试传 fake，生产默认 node-pty spawn）
   * 注入而非 mock：外部依赖可替换，业务逻辑保持真实实现
   */
  private readonly spawnFn: typeof spawn;

  constructor(options: { spawnFn?: typeof spawn } = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * 活跃终端 Map：terminalId → PTY 上下文
   *
   * 每个 PTY 独立关联一个 webContents，支持多窗口独立终端。
   * PTY 退出（onExit）时会从此 Map 移除，但 outputBuffer 保留在 outputBuffers 中供历史读取。
   */
  private readonly terminals = new Map<
    string,
    { readonly pty: IPty; readonly webContents: WebContents }
  >();

  /**
   * 终端输出缓冲：terminalId → 累积输出字符串
   *
   * 独立于 terminals Map 维护，PTY 退出后仍保留缓冲供历史读取。
   * 使用环形截断策略（MAX_BUFFER_BYTES），避免单缓冲内存膨胀；
   * 已退出终端的缓冲按 FIFO 保留最近 MAX_RETAINED_EXITED_BUFFERS 个，
   * 防长会话中逐个累积（每终端 ≤100KB）的无界增长。
   */
  private readonly outputBuffers = new Map<string, string>();

  /**
   * 各终端缓冲的累计字节数（2026-09-08 性能修复）
   *
   * 与 outputBuffers 同步维护，使「是否超限」判断从 O(buffer) 的
   * `Buffer.byteLength(全量)` 降为 O(1) 计数累加。
   */
  private readonly outputBufferBytes = new Map<string, number>();

  /** 已退出终端的缓冲保留队列（FIFO，超上限淘汰最旧） */
  private readonly exitedBufferOrder: string[] = [];

  /** 已退出终端保留的输出缓冲数量上限 */
  private static readonly MAX_RETAINED_EXITED_BUFFERS = 20;

  /**
   * 追加 PTY 输出到环形缓冲（2026-09-08 性能修复）
   *
   * 从 create 的 onData 回调提取（保持 create 在棘轮基线内）。
   * 维护累计字节计数使超限判断为 O(1)，仅在超限时做一次截断。
   */
  private appendToOutputBuffer(terminalId: string, data: string): void {
    const current = this.outputBuffers.get(terminalId) ?? '';
    const dataBytes = Buffer.byteLength(data, 'utf8');
    const currentBytes = this.outputBufferBytes.get(terminalId) ?? 0;
    if (currentBytes + dataBytes <= MAX_BUFFER_BYTES) {
      this.outputBuffers.set(terminalId, current + data);
      this.outputBufferBytes.set(terminalId, currentBytes + dataBytes);
      return;
    }
    // 环形截断：保留尾部 MAX_BUFFER_BYTES 字节
    const buf = Buffer.from(current + data, 'utf8');
    const truncated = buf.subarray(buf.length - MAX_BUFFER_BYTES).toString('utf8');
    this.outputBuffers.set(terminalId, truncated);
    this.outputBufferBytes.set(terminalId, Buffer.byteLength(truncated, 'utf8'));
  }

  /**
   * 创建终端会话
   *
   * 流程：
   * 1. 解析 shell 与 args（command 优先，省略时用默认 shell）
   * 2. 合并环境变量（系统 env + 用户 env）
   * 3. spawn PTY 进程
   * 4. 绑定 onData / onExit 事件，推送到 webContents
   * 5. 缓存 terminalId → { pty, webContents }
   *
   * @returns { terminalId } 终端唯一标识，渲染层用此 id 关联后续事件
   */
  async create(options: TerminalCreateOptions): Promise<TerminalCreateRes> {
    const terminalId = randomUUID();
    const { command, env, cols, rows, webContents } = options;
    // P3 修复：cwd 可省略——回退到用户主目录（渲染层无 Node API 获取 home，
    // 主进程按平台环境变量兜底），替代渲染层硬编码 DEFAULT_CWD
    const cwd = options.cwd ?? defaultHomeDir();

    // 解析 shell 与 args
    const { file, args } = this.resolveShell(command);

    // 合并环境变量：系统 env + 用户 env（用户覆盖系统同名，敏感键除外）
    // P0 安全：过滤系统关键变量，防止渲染层通过 env 覆盖 PATH/PATHEXT 等
    // 劫持终端内执行的命令（如把 ls 替换为恶意可执行文件）。
    // 系统关键变量以主进程 process.env 为准，用户 env 仅用于注入普通变量（如 API Key）。
    const mergedEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
    };
    if (env !== undefined) {
      for (const [key, value] of Object.entries(env)) {
        if (this.isSensitiveEnvKey(key)) {
          logger.warn({ key }, 'TerminalService 拒绝覆盖系统关键环境变量');
          continue;
        }
        mergedEnv[key] = value;
      }
    }

    let pty: IPty;
    try {
      pty = this.spawnFn(file, args, {
        // 终端名称（xterm.js 识别用）
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: mergedEnv,
      });
    } catch (error) {
      throw new AppError(ErrorCode.TERMINAL_SPAWN_FAILED, undefined, error, {
        file,
        args,
        cwd,
      });
    }

    // 推送终端创建事件（通知渲染层，包括 Agent 工具创建的终端）
    const title = command ?? file.split(/[\\/]/).pop() ?? 'shell';
    const createdPayload: TerminalCreatedEventPayload = {
      terminalId,
      title,
      pid: pty.pid,
      cwd,
      cols,
      rows,
    };
    if (!webContents.isDestroyed()) {
      // R2：统一出口 emitEvent（dev 契约校验）
      emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeCreatedEvent, createdPayload);
    }

    // 初始化输出缓冲
    this.outputBuffers.set(terminalId, '');
    this.outputBufferBytes.set(terminalId, 0);

    // 绑定输出事件：推送 terminal:event:output + 追加到 outputBuffer
    pty.onData((data: string) => {
      // dispose 后 in-flight 数据不再写回缓冲（防止已清空的 Map 被重新填充）
      if (!this.terminals.has(terminalId)) {
        return;
      }
      this.appendToOutputBuffer(terminalId, data);
      // 推送到渲染层（R2：统一出口 emitEvent）
      if (webContents.isDestroyed()) {
        return;
      }
      const payload: TerminalOutputEventPayload = { terminalId, data };
      emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeOutputEvent, payload);
    });

    // 绑定退出事件：推送 terminal:event:exit + 从 Map 移除
    // 注意：node-pty 的 onExit 回调 signal 类型为 number | undefined（信号编号），
    // 而 TerminalExitEventPayload.signal 期望 string（信号名如 'SIGTERM'），
    // 需通过 os.constants.signals 反向查找转换为信号名
    pty.onExit(({ exitCode, signal }) => {
      logger.info({ terminalId, exitCode, signal }, 'TerminalService PTY 已退出');
      // 推送退出事件（webContents 销毁后跳过）
      if (!webContents.isDestroyed()) {
        const signalName = signal !== undefined ? this.signalNumberToName(signal) : undefined;
        const payload: TerminalExitEventPayload = {
          terminalId,
          exitCode,
          ...(signalName !== undefined ? { signal: signalName } : {}),
        };
        // R2：统一出口 emitEvent（dev 契约校验）
        emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeExitEvent, payload);
      }
      // 从 Map 移除（若 dispose 已清空则 delete 无效，不报错）
      this.terminals.delete(terminalId);
      // 淘汰策略：已退出终端的缓冲按 FIFO 保留最近 N 个，防无界增长
      this.retireOutputBuffer(terminalId);
      // PTY 已退出：移除 destroyed 监听，避免窗口存活期间监听器累积
      webContents.removeListener('destroyed', onDestroyed);
    });

    // P1 修复：PTY 生命周期绑定 webContents——窗口销毁（macOS 关窗不退出 /
    // 渲染层崩溃）时自动 kill，此前窗口销毁后 PTY 进程继续存活（仅停止推送）
    const onDestroyed = (): void => {
      if (this.terminals.has(terminalId)) {
        logger.warn({ terminalId }, 'webContents 已销毁，自动 kill PTY');
        void this.kill(terminalId);
      }
    };
    webContents.once('destroyed', onDestroyed);

    this.terminals.set(terminalId, { pty, webContents });
    logger.info({ terminalId, file, cwd, pid: pty.pid }, 'TerminalService PTY 已创建');

    // title 同时给出：与 created 事件同源（`title` 变量在上方构造 payload 时已算出），
    // 渲染层据此显示真实 shell 名而无需自行推断平台默认 shell
    return { terminalId, pid: pty.pid, title };
  }

  /**
   * 向终端写入数据
   *
   * @returns ok=true 成功写入；ok=false 终端不存在或已关闭
   */
  async input(terminalId: string, data: string): Promise<TerminalInputRes> {
    const ctx = this.terminals.get(terminalId);
    if (ctx === undefined) {
      return { ok: false };
    }
    try {
      ctx.pty.write(data);
      return { ok: true };
    } catch (error) {
      logger.warn({ terminalId, error }, 'TerminalService 写入失败');
      return { ok: false };
    }
  }

  /**
   * 调整终端尺寸
   *
   * @returns ok=true 成功调整；ok=false 终端不存在或已关闭
   */
  async resize(terminalId: string, cols: number, rows: number): Promise<TerminalResizeRes> {
    const ctx = this.terminals.get(terminalId);
    if (ctx === undefined) {
      return { ok: false };
    }
    try {
      ctx.pty.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      logger.warn({ terminalId, error }, 'TerminalService resize 失败');
      return { ok: false };
    }
  }

  /**
   * 终止指定终端
   *
   * 调用 pty.kill() 后会异步触发 onExit 事件，由 onExit 回调从 Map 移除。
   * 这里不立即 delete，避免 onExit 回调中重复 delete（虽然 delete 已存在的 key 无副作用）。
   *
   * @returns ok=true 成功调用 kill；ok=false 终端不存在
   */
  async kill(terminalId: string): Promise<TerminalKillRes> {
    const ctx = this.terminals.get(terminalId);
    if (ctx === undefined) {
      return { ok: false };
    }
    try {
      ctx.pty.kill();
    } catch (error) {
      logger.warn({ terminalId, error }, 'TerminalService kill 失败');
    }
    return { ok: true };
  }

  /**
   * 获取终端历史输出
   *
   * 返回从终端创建开始累积的所有输出（含 ANSI 转义序列）。
   * PTY 退出后仍可读取历史输出。
   * 输出受 MAX_BUFFER_BYTES 环形截断限制，仅保留最近的输出。
   *
   * @returns 终端输出字符串，不存在时返回空字符串
   */
  getOutput(terminalId: string): string {
    return this.outputBuffers.get(terminalId) ?? '';
  }

  /**
   * 清空终端输出缓冲
   *
   * 仅清空内存中的输出缓冲，不影响正在运行的 PTY 进程。
   * 终端不存在时静默忽略。
   */
  clearOutput(terminalId: string): void {
    this.outputBuffers.delete(terminalId);
    this.outputBufferBytes.delete(terminalId);
    const idx = this.exitedBufferOrder.indexOf(terminalId);
    if (idx !== -1) {
      this.exitedBufferOrder.splice(idx, 1);
    }
  }

  /**
   * 淘汰已退出终端的输出缓冲（FIFO 上限）
   *
   * 缓冲按设计保留供历史读取，但无上限会在长会话中累积。
   * 仅保留最近 MAX_RETAINED_EXITED_BUFFERS 个，超出即删除最旧缓冲。
   */
  private retireOutputBuffer(terminalId: string): void {
    if (!this.outputBuffers.has(terminalId)) {
      return;
    }
    this.exitedBufferOrder.push(terminalId);
    while (this.exitedBufferOrder.length > TerminalService.MAX_RETAINED_EXITED_BUFFERS) {
      const oldest = this.exitedBufferOrder.shift();
      if (oldest !== undefined && !this.terminals.has(oldest)) {
        this.outputBuffers.delete(oldest);
        this.outputBufferBytes.delete(oldest);
      }
    }
  }

  /**
   * 优雅关闭：kill 所有活跃 PTY
   *
   * 应用退出时调用，避免 PTY 子进程句柄泄漏导致进程不退出。
   * kill 后 onExit 会异步触发，但应用即将退出，不等待事件回调。
   */
  async dispose(): Promise<void> {
    if (this.terminals.size > 0) {
      for (const [id, ctx] of this.terminals) {
        try {
          ctx.pty.kill();
        } catch (error) {
          logger.warn({ terminalId: id, error }, 'TerminalService dispose kill 失败');
        }
      }
      // 立即清空 Map（onExit 回调可能异步触发，但应用即将退出）
      this.terminals.clear();
    }
    // 清理所有输出缓冲（包括已退出终端的残留缓冲）
    this.outputBuffers.clear();
    this.outputBufferBytes.clear();
    this.exitedBufferOrder.length = 0;
    logger.info({}, 'TerminalService 所有 PTY 已清理');
  }

  /**
   * 判断环境变量键是否为系统关键变量（禁止渲染层覆盖）
   *
   * P0 安全：PATH/PATHEXT/SystemRoot/COMSPEC 等决定命令解析路径，
   * 允许渲染层覆盖等同于允许劫持终端内执行的任何命令。
   * - Windows：环境变量键大小写不敏感，统一大写比较
   * - POSIX：PATH 等大小写敏感，直接比较
   */
  private isSensitiveEnvKey(key: string): boolean {
    // 集合来自共享层单一真源；平台语义保持原样：
    // - Windows：环境变量键大小写不敏感 → 统一大写比较
    // - POSIX：大小写敏感（小写 path 是普通自定义变量，不应误伤）→ 原样比较
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    return TERMINAL_ENV_DENY_KEYS.has(normalized);
  }

  /**
   * 解析 shell 与 args
   *
   * command 非空时按 shell 语义拆词（R2 修复：此前按空白 split 不支持引号，
   * "git commit -m 'hello world'" 会被拆成 6 段错误参数）：
   * - 支持单/双引号包裹（含空格的参数）
   * - 支持反斜杠转义（单引号内除外，对齐 POSIX shell 语义）
   * - 不做变量展开/管道/重定向解析（复杂命令由交互式 shell 自行解析）
   * command 为空时返回默认 shell：
   * - Windows: powershell.exe（schema 约定）
   * - macOS/Linux: $SHELL 或 /bin/bash
   */
  private resolveShell(command: string | undefined): { file: string; args: string[] } {
    if (command !== undefined && command.length > 0) {
      const parts = splitShellWords(command);
      if (parts.length === 0) {
        return this.defaultShell();
      }
      // parts[0] 一定存在（filter 后非空数组）
      const file = parts[0] ?? '';
      const args = parts.slice(1);
      return { file, args };
    }
    return this.defaultShell();
  }

  /**
   * 信号编号 → 信号名
   *
   * node-pty onExit 回调的 signal 是 number（如 9 / 15），
   * 通过 os.constants.signals 反向查找转换为字符串名（如 'SIGKILL' / 'SIGTERM'），
   * 便于渲染层展示与跨平台兼容。
   *
   * 找不到匹配项时返回 'signal:<number>' 兜底（避免 undefined 丢失信息）。
   */
  private signalNumberToName(num: number): string {
    // os.constants.signals 是 Record<string, number>，反向遍历查找
    const signals = os.constants.signals as unknown as Record<string, number>;
    for (const [name, n] of Object.entries(signals)) {
      if (n === num) {
        return name;
      }
    }
    // 兜底：未知信号编号保留数字，渲染层可显示 'signal:32' 等
    return `signal:${num}`;
  }

  /**
   * 默认 shell
   *
   * Windows 用 powershell.exe（schema 约定，PowerShell 是现代化 Windows shell）
   * Unix 用 $SHELL 环境变量（通常 /bin/bash 或 /bin/zsh），fallback /bin/bash
   */
  private defaultShell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: [] };
    }
    // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
    const shell = process.env['SHELL'] ?? '/bin/bash';
    return { file: shell, args: [] };
  }
}

/**
 * 默认终端工作目录（P3 修复：替代渲染层硬编码 DEFAULT_CWD）
 *
 * 渲染层无 Node API 获取用户主目录，主进程按平台环境变量兜底：
 * - Windows：USERPROFILE（用户主目录）
 * - POSIX：HOME
 * 环境变量缺失时回退到平台根目录（spawn 可用路径）。
 */
function defaultHomeDir(): string {
  if (process.platform === 'win32') {
    return process.env['USERPROFILE'] ?? 'C:\\';
  }
  return process.env['HOME'] ?? '/';
}

/**
 * 按 shell 语义拆词（R2 修复：此前 resolveShell 按空白 split 不支持引号；
 * P1 修复：win32 下反斜杠按路径分隔符字面量处理，不再被当作 POSIX 转义符吞掉）
 *
 * 规则按平台分别定义：
 * - 非 win32（POSIX 子集）：双引号 "..." 包裹含空格参数且内含转义；
 *   单引号 '...' 全字面量；引号外反斜杠转义下一字符
 * - win32：反斜杠为字面量路径分隔符，仅双引号内 \" 转义引号本身
 *   （CommandLineToArgvW 常用子集）；单双引号分组语义同 POSIX
 * - 未闭合引号：容错处理——残余内容作为最后一段参数
 * - 不解析变量展开/管道/重定向（复杂命令交给交互式 shell）
 *
 * @example splitShellWords("git commit -m 'hello world'") // ['git','commit','-m','hello world']
 * @example splitShellWords('C:\\WINDOWS\\system32\\cmd.exe /c dir', 'win32')
 *   // ['C:\\WINDOWS\\system32\\cmd.exe', '/c', 'dir']
 */
export function splitShellWords(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const windows = platform === 'win32';
  const chars = [...input];
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let posixEscaped = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;

    if (ch === '\\') {
      if (!windows) {
        // POSIX：反斜杠转义下一字符；单引号内不转义（与 shell 一致）
        if (quote !== "'") {
          const next = chars[i + 1];
          if (next !== undefined) {
            current += next;
            i += 1;
          } else {
            posixEscaped = true;
          }
          continue;
        }
        current += ch;
        continue;
      }
      // Windows：反斜杠是路径分隔符（字面量），仅双引号内 \" 转义引号本身
      // （CommandLineToArgvW 约定常用子集）。修复前 C:\Users\foo 会被拆成 C:Usersfoo，
      // 导致任何含 Windows 路径的命令 spawn 失败（集成测试 terminal batch 5 实证）。
      if (quote === '"' && chars[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  // 容错：POSIX 悬空转义保留反斜杠；未闭合引号丢弃标记，残余作为最后参数
  if (posixEscaped) {
    current += '\\';
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

/** TerminalService 单例（内部按具体实现类持有，外部暴露为 ITerminalService 接口） */
let terminalService: TerminalService | null = null;

/**
 * 获取 TerminalService 单例
 *
 * 整个应用生命周期共享一个实例，内部 Map 管理 PTY。
 *
 * 返回类型为 ITerminalService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 TerminalService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getTerminalService(): ITerminalService {
  if (terminalService === null) {
    terminalService = new TerminalService();
  }
  return terminalService;
}

/**
 * 重置 TerminalService（仅测试用）
 *
 * 调用 dispose kill 所有 PTY，并清空单例缓存。
 */
export async function resetTerminalService(): Promise<void> {
  if (terminalService !== null) {
    await terminalService.dispose();
    terminalService = null;
  }
}
