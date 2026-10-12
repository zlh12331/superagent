// terminal-service.ts：终端服务——node-pty 会话管理（创建/输入/改尺寸/杀），输出环形缓冲 +
// 流式推送（terminal:stream:output 事件）+ 退出后缓冲留存供 getOutput 补拉
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

export interface TerminalCreateOptions {
  readonly cwd?: string;
  readonly command: string | undefined;
  readonly env: Record<string, string> | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly webContents: WebContents;
}

/** 终端服务契约（IPC handler 与 run-command 工具共同消费） */
export interface ITerminalService {
  create(options: TerminalCreateOptions): Promise<TerminalCreateRes>;
  input(terminalId: string, data: string): Promise<TerminalInputRes>;
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResizeRes>;
  kill(terminalId: string): Promise<TerminalKillRes>;
  getOutput(terminalId: string): string;
  clearOutput(terminalId: string): void;
  dispose(): Promise<void>;
}

// 每终端输出环形缓冲 100KB（断线重连补拉）；退出的终端保留最近 20 份缓冲（防历史瞬间被清）
const MAX_BUFFER_BYTES = 100 * 1024;

export class TerminalService implements ITerminalService {
  // spawn 可注入（测试不打真实 pty）
  private readonly spawnFn: typeof spawn;

  constructor(options: { spawnFn?: typeof spawn } = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  private readonly terminals = new Map<
    string,
    { readonly pty: IPty; readonly webContents: WebContents }
  >();

  private readonly outputBuffers = new Map<string, string[]>();

  private readonly outputBufferBytes = new Map<string, number>();

  private readonly exitedBufferOrder: string[] = [];

  private static readonly MAX_RETAINED_EXITED_BUFFERS = 20;

  // dispose 时杀全部 pty 的 SIGKILL 升级宽限（3s 不退强杀，防孤儿 pty 挂住退出链）
  private static readonly DISPOSE_ESCALATION_MS = 3_000;

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

  getOutput(terminalId: string): string {
    return (this.outputBuffers.get(terminalId) ?? []).join('');
  }

  clearOutput(terminalId: string): void {
    this.outputBuffers.delete(terminalId);
    this.outputBufferBytes.delete(terminalId);
    const idx = this.exitedBufferOrder.indexOf(terminalId);
    if (idx !== -1) {
      this.exitedBufferOrder.splice(idx, 1);
    }
  }

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

  private isSensitiveEnvKey(key: string): boolean {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    return TERMINAL_ENV_DENY_KEYS.has(normalized);
  }

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

  private signalNumberToName(num: number): string {
    const signals = os.constants.signals as unknown as Record<string, number>;
    for (const [name, n] of Object.entries(signals)) {
      if (n === num) {
        return name;
      }
    }
    return `signal:${num}`;
  }

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

function defaultHomeDir(): string {
  if (process.platform === 'win32') {
    return process.env['USERPROFILE'] ?? 'C:\\';
  }
  return process.env['HOME'] ?? '/';
}

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

let terminalService: TerminalService | null = null;

export function getTerminalService(): ITerminalService {
  if (terminalService === null) {
    terminalService = new TerminalService();
  }
  return terminalService;
}

export async function resetTerminalService(): Promise<void> {
  if (terminalService !== null) {
    await terminalService.dispose();
    terminalService = null;
  }
}
