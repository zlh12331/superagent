import { type ChildProcess, spawn } from 'node:child_process';
import { z } from 'zod';
import { t } from '../../i18n';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * 危险命令扫描前的保守归一化（2026-09-08 安全修复）
 *
 * 让「引号包裹」与「-- 分隔」变体与原形落在同一文本：删引号（shell 展开等价）
 * + 独立 `--` 替换为空格。仅用于拦截判定，执行仍用原始命令。
 */
function normalizeForDangerScan(command: string): string {
  return command.replace(/['"`]/g, '').replace(/(^|\s)--(?=\s|$)/g, '$1');
}

const DANGEROUS_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\s+[/~]/i,
    reason: '禁止递归删除根目录或用户目录',
  },
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\s+\$HOME/i,
    reason: '禁止递归删除用户目录',
  },
  { pattern: /\bmkfs\b/i, reason: '禁止格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: '禁止覆写块设备' },
  { pattern: /:\s*\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: '禁止执行 fork bomb' },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, reason: '禁止全局修改根目录权限' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '禁止执行关机/重启命令' },
  { pattern: /\bformat\s+[a-z]:/i, reason: '禁止格式化磁盘' },
  { pattern: /\bdiskpart\b/i, reason: '禁止磁盘分区操作' },
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\s+\$\{HOME\}/i,
    reason: '禁止递归删除用户目录（变量展开变体）',
  },
  {
    pattern: /\bcd\s+[/~]\s*(&&|;)\s*rm\s+(-[a-z]*r[a-z]*f?)\b/i,
    reason: '禁止切换到根/用户目录后递归删除（组合攻击）',
  },
  {
    pattern: /\brm\b[^\n]*--no-preserve-root/i,
    reason: '禁止使用 --no-preserve-root 删除根目录',
  },
];
const RunCommandInputSchema = z.object({
  command: z.string().min(1).describe('要执行的 shell 命令（支持管道、重定向、环境变量展开）'),
  cwd: z
    .string()
    .optional()
    .describe('工作目录（相对路径基于 agent 工作目录解析，省略时用工作目录）')
    .transform((v) => v ?? undefined),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(`超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`),
});

type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

/**
 * 进程树终止：shell（cmd.exe / sh）只是包装层，真正的孙进程（npm/ping 等）
 * 持有 stdio 写端句柄——仅 kill shell 本体时 close 事件永不触发（Node 要求
 * 进程退出且 stdio 流关闭才 emit），Promise 悬挂到回合看门狗兜底。
 * - win32：taskkill /T 连同整棵子进程树终止
 * - POSIX：spawn detached 使 shell 为进程组组长，负 pid 信号覆盖全组
 */
function killTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
}

interface RunCommandOutput {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** stdout 是否被截断（超 MAX_OUTPUT_BYTES，保留头部） */
  readonly stdoutTruncated: boolean;
  /** stderr 是否被截断 */
  readonly stderrTruncated: boolean;
}

/**
 * 创建 run_command 工具（在工作目录内执行 shell 命令：DANGEROUS_PATTERNS 拦截高危命令，
 * 超时默认 30s 上限 5 分钟；ask 级审批）
 */
export function createRunCommandTool(): Tool<RunCommandInput> {
  return {
    name: 'run_command',
    description:
      '在指定工作目录内执行 shell 命令（支持管道、重定向、环境变量展开）。会修改文件系统或执行任意代码，需用户审批后执行。超时时间默认 30 秒，可通过 timeout 参数延长至最多 5 分钟。返回 stdout / stderr / exitCode / signal。',
    inputSchema: RunCommandInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: RunCommandInput, ctx: ToolContext): Promise<ToolResult> => {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(input.command) || pattern.test(normalizeForDangerScan(input.command))) {
          return {
            title: t('tools.runCommand.title', { command: input.command }),
            output: `[安全拦截] ${reason}：${input.command}`,
            metadata: {
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: `[安全拦截] ${reason}：${input.command}`,
              timedOut: false,
              blocked: true,
              blockReason: reason,
            },
          };
        }
      }

      const { resolved, realTarget } =
        input.cwd !== undefined
          ? resolveWithinWorkspace(input.cwd, ctx.workingDir)
          : { resolved: ctx.workingDir, realTarget: ctx.workingDir };

      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
      const shellFlag = isWin ? '/c' : '-c';

      const result: RunCommandOutput = await new Promise<RunCommandOutput>((resolve) => {
        const child = spawn(shell, [shellFlag, input.command], {
          cwd: realTarget,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          ...(isWin ? {} : { detached: true }),
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const appendTruncated = (
          data: Buffer,
          buf: string,
          truncated: boolean,
        ): { buf: string; truncated: boolean } => {
          if (truncated) return { buf, truncated };
          if (Buffer.byteLength(buf, 'utf8') + data.length > MAX_OUTPUT_BYTES) {
            return { buf, truncated: true };
          }
          return { buf: buf + data.toString('utf8'), truncated: false };
        };

        if (child.stdout !== null) {
          child.stdout.on('data', (data: Buffer) => {
            const r = appendTruncated(data, stdoutBuf, stdoutTruncated);
            stdoutBuf = r.buf;
            stdoutTruncated = r.truncated;
          });
        }
        if (child.stderr !== null) {
          child.stderr.on('data', (data: Buffer) => {
            const r = appendTruncated(data, stderrBuf, stderrTruncated);
            stderrBuf = r.buf;
            stderrTruncated = r.truncated;
          });
        }

        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child, false);
          setTimeout(() => {
            if (!settled) {
              killTree(child, true);
            }
          }, 2000).unref();
          setTimeout(() => {
            if (!settled) {
              settled = true;
              ctx.abortSignal.removeEventListener('abort', onAbort);
              resolve({
                exitCode: null,
                signal: 'SIGKILL',
                stdout: stdoutBuf,
                stderr: stderrBuf,
                timedOut,
                stdoutTruncated,
                stderrTruncated,
              });
            }
          }, 5000).unref();
        }, input.timeout);
        timer.unref();

        const onAbort = (): void => {
          killTree(child, false);
        };
        if (!ctx.abortSignal.aborted) {
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        } else {
          try {
            child.kill('SIGTERM');
          } catch {}
        }

        child.on('close', (code, signal) => {
          settled = true;
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);

          resolve({
            exitCode: code,
            signal: signal,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            timedOut,
            stdoutTruncated,
            stderrTruncated,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);

          resolve({
            exitCode: null,
            signal: null,
            stdout: stdoutBuf,
            stderr: `${stderrBuf}\n[spawn error] ${err.message}`,
            timedOut: false,
            stdoutTruncated,
            stderrTruncated,
          });
        });
      });

      const outputParts: string[] = [];
      if (result.stdout) {
        outputParts.push(result.stdout);
      }
      if (result.stderr) {
        outputParts.push(result.stderr);
      }
      const truncated = result.stdoutTruncated || result.stderrTruncated;
      if (truncated) {
        outputParts.push(`[输出已截断：超 ${MAX_OUTPUT_BYTES / 1024}KB 上限，仅保留开头部分]`);
      }
      const output = outputParts.join('\n') || '(无输出)';

      const exitDesc = result.timedOut
        ? '超时'
        : result.exitCode === 0
          ? '成功'
          : `失败 (exit=${result.exitCode})`;

      return {
        title: t('tools.runCommand.title', { command: input.command }),
        output,
        metadata: {
          command: input.command,
          cwd: resolved,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          truncated,
          status: exitDesc,
        },
      };
    },
  };
}
