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
import { AppError, ErrorCode, IPC_CHANNELS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { type IPty, spawn } from 'node-pty';
import { logger } from '../../utils/logger';

/**
 * create 方法入参
 *
 * 与 TerminalCreateReqSchema 字段对齐，类型独立定义以便测试 mock。
 * webContents 由 IPC handler 注入（ctx.sender），用于推送终端事件。
 */
export interface TerminalCreateOptions {
  /** 工作目录（绝对路径） */
  readonly cwd: string;
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
class TerminalService implements ITerminalService {
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
   * 使用环形截断策略（MAX_BUFFER_BYTES），避免内存膨胀。
   */
  private readonly outputBuffers = new Map<string, string>();

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
    const { command, cwd, env, cols, rows, webContents } = options;

    // 解析 shell 与 args
    const { file, args } = this.resolveShell(command);

    // 合并环境变量：系统 env + 用户 env（用户覆盖系统同名）
    // node-pty env 接受 { [key: string]: string | undefined }
    const mergedEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(env ?? {}),
    };

    let pty: IPty;
    try {
      pty = spawn(file, args, {
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
      webContents.send(IPC_CHANNELS.TERMINAL_EVENT_CREATED, createdPayload);
    }

    // 初始化输出缓冲
    this.outputBuffers.set(terminalId, '');

    // 绑定输出事件：推送 terminal:event:output + 追加到 outputBuffer
    pty.onData((data: string) => {
      // 追加到输出缓冲（环形截断）
      const current = this.outputBuffers.get(terminalId) ?? '';
      const combined = current + data;
      if (Buffer.byteLength(combined, 'utf8') > MAX_BUFFER_BYTES) {
        // 环形截断：保留尾部 MAX_BUFFER_BYTES 字节
        const buf = Buffer.from(combined, 'utf8');
        const truncated = buf.subarray(buf.length - MAX_BUFFER_BYTES).toString('utf8');
        this.outputBuffers.set(terminalId, truncated);
      } else {
        this.outputBuffers.set(terminalId, combined);
      }
      // 推送到渲染层
      if (webContents.isDestroyed()) {
        return;
      }
      const payload: TerminalOutputEventPayload = { terminalId, data };
      webContents.send(IPC_CHANNELS.TERMINAL_EVENT_OUTPUT, payload);
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
        webContents.send(IPC_CHANNELS.TERMINAL_EVENT_EXIT, payload);
      }
      // 从 Map 移除（若 dispose 已清空则 delete 无效，不报错）
      this.terminals.delete(terminalId);
    });

    this.terminals.set(terminalId, { pty, webContents });
    logger.info({ terminalId, file, cwd, pid: pty.pid }, 'TerminalService PTY 已创建');

    return { terminalId, pid: pty.pid };
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
    logger.info({}, 'TerminalService 所有 PTY 已清理');
  }

  /**
   * 解析 shell 与 args
   *
   * command 非空时拆分为 file + args（按空白分割，不处理引号嵌套）。
   * command 为空时返回默认 shell：
   * - Windows: powershell.exe（schema 约定）
   * - macOS/Linux: $SHELL 或 /bin/bash
   *
   * 注意：简单 split 不处理引号嵌套（如 "git commit -m 'hello world'"）。
   * Code Agent 场景下通常传入单个可执行文件路径，复杂命令由 shell 自行解析。
   * 后续可引入 shell-quote 库做更健壮的解析。
   */
  private resolveShell(command: string | undefined): { file: string; args: string[] } {
    if (command !== undefined && command.length > 0) {
      const parts = command.split(/\s+/).filter((s) => s.length > 0);
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
