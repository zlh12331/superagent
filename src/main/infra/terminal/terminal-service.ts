import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  isShellChoiceApplicable,
  TERMINAL_ENV_DENY_KEYS,
  TERMINAL_SHELL_CHOICES,
  type TerminalShellChoice,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { type IPty, spawn } from 'node-pty';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';
import { readSetting } from '../storage/settings-pref';

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
   * 终端输出缓冲：terminalId → 输出分片数组
   *
   * 独立于 terminals Map 维护，PTY 退出后仍保留缓冲供历史读取。
   * P2-35：分片数组 + outputBufferBytes 总长计数——追加为 O(1)（push 分片 +
   * 计数累加），替代字符串拼接（每次复制整个累积串，O(total)）；
   * 超限按头部丢弃分片（消费方语义不变：仍保留尾部最新输出）。
   * 已退出终端的缓冲按 FIFO 保留最近 MAX_RETAINED_EXITED_BUFFERS 个，
   * 防长会话中逐个累积（每终端 ≤100KB）的无界增长。
   */
  private readonly outputBuffers = new Map<string, string[]>();

  /**
   * 各终端缓冲的累计字节数（2026-09-08 性能修复）
   *
   * 与 outputBuffers 同步维护，使「是否超限」判断保持 O(1) 计数累加。
   */
  private readonly outputBufferBytes = new Map<string, number>();

  /** 已退出终端的缓冲保留队列（FIFO，超上限淘汰最旧） */
  private readonly exitedBufferOrder: string[] = [];

  /** 已退出终端保留的输出缓冲数量上限 */
  private static readonly MAX_RETAINED_EXITED_BUFFERS = 20;

  /** dispose 强杀升级等待：kill 后仍未退出多久升级强杀（对齐 terminate-child 的 3s 口径） */
  private static readonly DISPOSE_ESCALATION_MS = 3_000;

  /**
   * 追加 PTY 输出到分片环形缓冲（P2-35：O(1) 追加，超限按头部丢弃分片）
   *
   * 从 create 的 onData 回调提取（保持 create 在棘轮基线内）。
   * 超限优先整片丢弃头部（O(1) 均摊）；仅当越界字节落在头片中段时对该片
   * 做一次字节级截边——「保留尾部 MAX_BUFFER_BYTES 字节」的语义与旧实现一致
   * （切片在多字节字符中段可能产生替换字符，与旧 subarray 行为相同）。
   */
  private appendToOutputBuffer(terminalId: string, data: string): void {
    const chunks = this.outputBuffers.get(terminalId) ?? [];
    let totalBytes = this.outputBufferBytes.get(terminalId) ?? 0;
    chunks.push(data);
    totalBytes += Buffer.byteLength(data, 'utf8');
    let overflow = totalBytes - MAX_BUFFER_BYTES;
    while (overflow > 0 && chunks.length > 0) {
      const head = chunks[0];
      if (head === undefined) break;
      const headBytes = Buffer.byteLength(head, 'utf8');
      if (headBytes <= overflow) {
        chunks.shift();
        overflow -= headBytes;
        totalBytes -= headBytes;
        continue;
      }
      const kept = Buffer.from(head, 'utf8').subarray(overflow).toString('utf8');
      const keptBytes = Buffer.byteLength(kept, 'utf8');
      totalBytes += keptBytes - headBytes;
      chunks[0] = kept;
      overflow = 0;
    }
    this.outputBuffers.set(terminalId, chunks);
    this.outputBufferBytes.set(terminalId, totalBytes);
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
    const cwd = options.cwd ?? defaultHomeDir();

    const { file, args } = this.resolveShell(command);

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
      emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeCreatedEvent, createdPayload);
    }

    this.outputBuffers.set(terminalId, []);
    this.outputBufferBytes.set(terminalId, 0);

    pty.onData((data: string) => {
      if (!this.terminals.has(terminalId)) {
        return;
      }
      this.appendToOutputBuffer(terminalId, data);
      if (webContents.isDestroyed()) {
        return;
      }
      const payload: TerminalOutputEventPayload = { terminalId, data };
      emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeOutputEvent, payload);
    });

    pty.onExit(({ exitCode, signal }) => {
      logger.info({ terminalId, exitCode, signal }, 'TerminalService PTY 已退出');
      if (!webContents.isDestroyed()) {
        const signalName = signal !== undefined ? this.signalNumberToName(signal) : undefined;
        const payload: TerminalExitEventPayload = {
          terminalId,
          exitCode,
          ...(signalName !== undefined ? { signal: signalName } : {}),
        };
        emitEvent(webContents, IPC_DEFINITIONS.terminal.subscribeExitEvent, payload);
      }
      this.terminals.delete(terminalId);
      this.retireOutputBuffer(terminalId);
      webContents.removeListener('destroyed', onDestroyed);
    });

    const onDestroyed = (): void => {
      if (this.terminals.has(terminalId)) {
        logger.warn({ terminalId }, 'webContents 已销毁，自动 kill PTY');
        void this.kill(terminalId);
      }
    };
    webContents.once('destroyed', onDestroyed);

    this.terminals.set(terminalId, { pty, webContents });
    logger.info({ terminalId, file, cwd, pid: pty.pid }, 'TerminalService PTY 已创建');

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
    return (this.outputBuffers.get(terminalId) ?? []).join('');
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
   * 优雅关闭：kill 所有活跃 PTY，未退出者 3s 后升级强杀（防孤儿）
   *
   * 应用退出时调用，避免 PTY 子进程句柄泄漏导致进程不退出。
   * 对照 memory-hub-service.stop 的「kill → onExit 早放行 → 3s 兜底」形态：
   * 等待退出期间挂 onExit（正常路径立即放行），超时未退出则升级强杀后放行
   * （总体最多阻塞 dispose 链 3s，与链上其他 3s 兜底一致）。
   */
  async dispose(): Promise<void> {
    if (this.terminals.size > 0) {
      await Promise.all(
        [...this.terminals.entries()].map(([id, ctx]) => this.killWithEscalation(id, ctx.pty)),
      );
      this.terminals.clear();
    }
    this.outputBuffers.clear();
    this.outputBufferBytes.clear();
    this.exitedBufferOrder.length = 0;
    logger.info({}, 'TerminalService 所有 PTY 已清理');
  }

  /**
   * kill 单个 PTY 并等待退出；DISPOSE_ESCALATION_MS 未退出则升级强杀
   *
   * 退出路径上 fire-and-forget 无效（app.exit(0) 会丢弃未触发的定时器），
   * 必须在 dispose 内等待升级真正发出，故对照 memory-hub-service.stop 的
   * Promise 形态实现，而非复用 terminateChild（ChildProcess 事件模型不兼容，见下）。
   */
  private async killWithEscalation(terminalId: string, pty: IPty): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      pty.onExit(finish);
      try {
        pty.kill();
      } catch (error) {
        logger.warn({ terminalId, error }, 'TerminalService dispose kill 失败');
      }
      const timer = setTimeout(() => {
        logger.warn({ terminalId }, 'TerminalService PTY kill 后未退出，升级强杀');
        this.escalateKill(terminalId, pty);
        finish();
      }, TerminalService.DISPOSE_ESCALATION_MS);
      timer.unref?.();
    });
  }

  /**
   * 强杀升级（平台差异，node-pty 1.1.0 实证）：
   * - Unix：kill() 仅向 shell pid 发 SIGHUP（unixTerminal.js，可被忽略 → 孤儿残留），
   *   升级为 SIGKILL（IPty.kill(signal) 在 Unix 有效）
   * - Windows：kill(signal) 直接抛错（'Signals not supported on windows'），
   *   且 kill() 本身已遍历 console 进程列表逐 pid 终止（ConPTY/winpty 均整树，
   *   windowsPtyAgent.js），无信号可升级、残留属 node-pty 层已尽力
   */
  private escalateKill(terminalId: string, pty: IPty): void {
    if (process.platform === 'win32') {
      return;
    }
    try {
      pty.kill('SIGKILL');
    } catch (error) {
      logger.warn({ terminalId, error }, 'TerminalService PTY 强杀失败');
    }
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
    const signals = os.constants.signals as unknown as Record<string, number>;
    for (const [name, n] of Object.entries(signals)) {
      if (n === num) {
        return name;
      }
    }
    return `signal:${num}`;
  }

  /**
   * 默认 shell
   *
   * 36 号 B：用户配置优先（settings.terminal.shell，spawn 时刻即时读）——配置在
   * 当前平台不可用 / 可执行文件不存在 / 读设置失败时回落平台默认（fail-open 向
   * 既有行为；回落路径补 warn 留诊断痕迹）。显式配置的 shell 通过存在性预检后
   * spawn 仍失败 → TERMINAL_SPAWN_FAILED 抛错（不做静默回退：显式配置的错误要
   * 可见，静默回退会造成「配置了但没生效」的困惑）。
   *
   * 平台默认（auto）：Windows 用 powershell.exe（schema 约定，PowerShell 是现代
   * 化 Windows shell）；Unix 用 $SHELL 环境变量，fallback /bin/bash
   */
  private defaultShell(): { file: string; args: string[] } {
    const choice = this.readShellChoice();
    if (choice !== 'auto') {
      const resolved = resolveShellChoice(choice, process.platform);
      if (resolved !== undefined) {
        return resolved;
      }
      logger.warn(
        { choice, platform: process.platform },
        '终端 shell 配置在当前平台不可用或可执行文件不存在，回落平台默认',
      );
    }
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: [] };
    }
    const shell = process.env['SHELL'] ?? '/bin/bash';
    return { file: shell, args: [] };
  }

  /**
   * 读终端 shell 配置（即时读 + 字段收窄，36 号 B）
   *
   * DB 值不可信：非对象 / shell 非法档位 → 'auto'（平台默认语义）；读取异常
   * fail-open 回 'auto' 并记 warn（同 notification readNotificationSettings 范式，
   * 正常路径零日志）。fontSize 是渲染层 xterm 消费的字段，主进程不读。
   */
  private readShellChoice(): TerminalShellChoice {
    try {
      const value: unknown = readSetting('terminal');
      if (typeof value !== 'object' || value === null) {
        return 'auto';
      }
      const shell = (value as { shell?: unknown }).shell;
      const choices = TERMINAL_SHELL_CHOICES as readonly unknown[];
      return choices.includes(shell) ? (shell as TerminalShellChoice) : 'auto';
    } catch (err) {
      logger.warn({ error: String(err) }, '终端设置读取失败（按平台默认兜底）');
      return 'auto';
    }
  }
}

/**
 * 解析用户配置的 shell 档位为可执行文件（36 号 B，导出供测试）
 *
 * 纯函数：fs 存在性经 fileExists 注入（测试无需真实文件系统）。返回 undefined
 * 表示「无法解析」（档位平台不适用 / 可执行文件不存在），调用方回落平台默认。
 *
 * - windows：powershell/cmd/wsl 按 PATH 解析（System32 内置，不做 fs 预检）；
 *   gitbash 候选路径逐个探测（Git for Windows 安装位置不固定）
 * - unix：绝对路径 + 存在性预检（fish 安装位置差异大，缺席即回落）
 */
export function resolveShellChoice(
  choice: TerminalShellChoice,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean = existsSync,
): { file: string; args: string[] } | undefined {
  const normalized: 'windows' | 'macos' | 'linux' =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  if (!isShellChoiceApplicable(choice, normalized)) {
    return undefined;
  }
  if (normalized === 'windows') {
    switch (choice) {
      case 'powershell':
        return { file: 'powershell.exe', args: [] };
      case 'cmd':
        return { file: 'cmd.exe', args: [] };
      case 'wsl':
        return { file: 'wsl.exe', args: [] };
      case 'gitbash': {
        const candidates = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          ...(process.env['LOCALAPPDATA']
            ? [`${process.env['LOCALAPPDATA']}\\Programs\\Git\\bin\\bash.exe`]
            : []),
        ];
        const hit = candidates.find((path) => fileExists(path));
        return hit !== undefined ? { file: hit, args: [] } : undefined;
      }
      default:
        return undefined;
    }
  }
  const unixTargets: Partial<Record<TerminalShellChoice, string>> = {
    bash: '/bin/bash',
    zsh: '/bin/zsh',
    fish: '/usr/bin/fish',
  };
  const target = unixTargets[choice];
  if (target === undefined || !fileExists(target)) {
    return undefined;
  }
  return { file: target, args: [] };
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
