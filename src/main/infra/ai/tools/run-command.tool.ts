// src/main/infra/ai/tools/run-command.tool.ts
// run_command 工具：在沙箱工作目录内执行 shell 命令
// ──────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

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

interface RunCommandOutput {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function createRunCommandTool(): Tool<RunCommandInput> {
  return {
    name: 'run_command',
    description:
      '在指定工作目录内执行 shell 命令（支持管道、重定向、环境变量展开）。会修改文件系统或执行任意代码，需用户审批后执行。超时时间默认 30 秒，可通过 timeout 参数延长至最多 5 分钟。返回 stdout / stderr / exitCode / signal。',
    inputSchema: RunCommandInputSchema,
    permission: 'ask',
    execute: async (input: RunCommandInput, ctx: ToolContext): Promise<ToolResult> => {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(input.command)) {
          return {
            title: `执行命令: ${input.command}`,
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

      const cwd =
        input.cwd !== undefined
          ? resolveWithinWorkspace(input.cwd, ctx.workingDir)
          : ctx.workingDir;

      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
      const shellFlag = isWin ? '/c' : '-c';

      const result: RunCommandOutput = await new Promise<RunCommandOutput>((resolve) => {
        const child = spawn(shell, [shellFlag, input.command], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
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
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 2000).unref();
        }, input.timeout);
        timer.unref();

        const onAbort = (): void => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        };
        if (!ctx.abortSignal.aborted) {
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }

        child.on('close', (code, signal) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);

          resolve({
            exitCode: code,
            signal: signal,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            timedOut,
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
      const output = outputParts.join('\n') || '(无输出)';

      const exitDesc = result.timedOut
        ? '超时'
        : result.exitCode === 0
          ? '成功'
          : `失败 (exit=${result.exitCode})`;

      return {
        title: `执行命令: ${input.command}`,
        output,
        metadata: {
          command: input.command,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          status: exitDesc,
        },
      };
    },
  };
}
