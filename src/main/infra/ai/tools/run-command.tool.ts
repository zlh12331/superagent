// src/main/infra/ai/tools/run-command.tool.ts
// run_command 工具：在沙箱工作目录内执行 shell 命令
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 command / cwd / timeout 入参
// - 通过 child_process.spawn 执行（shell 模式，支持管道与重定向）
// - 收集 stdout / stderr / exitCode / signal
// - 默认 cwd 为 ctx.workingDir，超时默认 30s，上限 300s
// - 监听 abortSignal：用户中断 agent 后立即 kill 子进程
//
// 权限：'ask'（执行任意命令有副作用且不可逆，需用户审批）
//
// 安全设计：
// - 命令以 shell 模式执行（'sh -c' 或 'cmd /c'），支持管道 / 重定向 / 环境变量展开
// - 不限制命令内容（审批环节由用户判断风险）
// - cwd 必须在 workingDir 内（通过 path-guard 校验，防止越权）
// - 子进程继承主进程环境变量（不显式注入）
//
// 输出：
// - exitCode: 进程退出码（0=成功，非 0=失败）
// - stdout: 标准输出（UTF-8 截断到 100KB，超出部分丢弃）
// - stderr: 标准错误（UTF-8 截断到 100KB）
// - signal: 进程被信号终止时的信号名（如 'SIGTERM'），否则为 null
// - timedOut: 是否因超时被 kill
// ──────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * stdout / stderr 最大保留字节数
 *
 * LLM 上下文有限，过长的输出会浪费 token。
 * 100KB 足够覆盖大多数构建工具 / 测试框架的输出，
 * 超出部分尾部丢弃（保留头部，便于看到错误起始位置）。
 */
const MAX_OUTPUT_BYTES = 100 * 1024;

/**
 * 默认超时时间（30 秒）
 *
 * 覆盖大多数快命令（git status / npm run build / 单测套件）。
 * 长时间命令（如 npm install / 大型构建）应显式传 timeout 参数。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 超时上限（5 分钟）
 *
 * 防止 LLM 误传巨大数值导致进程长期挂起。
 */
const MAX_TIMEOUT_MS = 300_000;

/**
 * run_command 工具入参 zod schema
 */
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

/** run_command 工具入参类型 */
type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

/**
 * run_command 工具输出
 *
 * 与 packages/shared/src/schemas/tool.ts 的 ToolResultSchema.output 对齐（unknown），
 * 但具体工具内部有明确类型，便于 execute 返回值类型检查。
 */
interface RunCommandOutput {
  /** 进程退出码（0=成功，非 0=失败；被信号终止时为 null） */
  readonly exitCode: number | null;
  /** 进程被信号终止时的信号名（如 'SIGTERM'），否则为 null */
  readonly signal: string | null;
  /** 标准输出（UTF-8，截断到 100KB） */
  readonly stdout: string;
  /** 标准错误（UTF-8，截断到 100KB） */
  readonly stderr: string;
  /** 是否因超时被 kill */
  readonly timedOut: boolean;
}

/**
 * 工厂函数：创建 run_command 工具实例
 *
 * @returns Tool 实例（permission: 'ask'）
 */
export function createRunCommandTool(): Tool<RunCommandInput, RunCommandOutput> {
  return {
    name: 'run_command',
    description:
      '在指定工作目录内执行 shell 命令（支持管道、重定向、环境变量展开）。会修改文件系统或执行任意代码，需用户审批后执行。超时时间默认 30 秒，可通过 timeout 参数延长至最多 5 分钟。返回 stdout / stderr / exitCode / signal。',
    inputSchema: RunCommandInputSchema,
    permission: 'ask',
    execute: async (input: RunCommandInput, ctx: ToolContext): Promise<RunCommandOutput> => {
      // 解析工作目录（默认 ctx.workingDir）
      const cwd =
        input.cwd !== undefined
          ? resolveWithinWorkspace(input.cwd, ctx.workingDir)
          : ctx.workingDir;

      // shell 与 args：跨平台使用 sh -c / cmd /c
      // Windows 用 process.env.ComSpec（通常是 cmd.exe），其他平台用 /bin/sh
      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
      const shellFlag = isWin ? '/c' : '-c';

      return new Promise<RunCommandOutput>((resolve) => {
        // 中断信号处理：agent 被中断后立即 kill 子进程
        // onAbort 回调注册在 abortSignal 上，子进程退出时移除
        const child = spawn(shell, [shellFlag, input.command], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        // 输出缓冲区（超过 MAX_OUTPUT_BYTES 后丢弃后续数据）
        let stdoutBuf = '';
        let stderrBuf = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        // 截断写入：超过 MAX_OUTPUT_BYTES 后停止追加（保留头部）
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

        // 超时定时器：到期后 kill 子进程
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // kill 已退出的进程会抛错，忽略
          }
          // SIGTERM 后 2s 仍未退出，SIGKILL 强制清理
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 2000).unref();
        }, input.timeout);
        timer.unref();

        // agent 中断处理：abortSignal 触发时 kill 子进程
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
          // 已中断，立即 kill
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }

        // 子进程退出：resolve Promise
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

        // spawn 错误（如 shell 不存在）：直接 resolve，不 reject
        // LLM 需要看到错误信息以决定下一步动作
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
    },
  };
}
