import { statSync } from 'node:fs';
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import type { ITerminalService } from '../infra/terminal/terminal-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 校验终端工作目录真实存在且为目录
 *
 * 不做「必须在工作区内」的检查——理由见文件头「安全边界」说明。
 *
 * @throws AppError(NOT_FOUND) 路径不存在 / 不可访问
 * @throws AppError(INVALID_INPUT) 存在但不是目录
 */
export function assertExistingDirectory(cwd: string): void {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new AppError(ErrorCode.NOT_FOUND, `终端工作目录不存在：${cwd}`);
  }
  if (!isDirectory) {
    throw new AppError(ErrorCode.INVALID_INPUT, `终端工作目录不是目录：${cwd}`);
  }
}

/**
 * 终端域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 TerminalService 实现：
 * - 生产环境：ServiceContainer 注入默认 TerminalService 实例（基于 node-pty）
 * - 测试环境：可注入 mock 实现，不依赖真实 PTY 子进程
 */
export interface TerminalHandlerDeps {
  /** TerminalService 实例（由 ServiceContainer 注入） */
  readonly terminalService: ITerminalService;
}

/**
 * 创建终端域 handler 实现
 *
 * @param deps 依赖项：包含 ITerminalService 实例
 */
export function createTerminalHandlers(
  deps: TerminalHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['terminal'] {
  const { terminalService } = deps;

  return {
    create: async (input, ctx) => {
      if (input.cwd !== undefined) {
        assertExistingDirectory(input.cwd);
      }
      return terminalService.create({
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        command: input.command,
        env: input.env,
        cols: input.cols,
        rows: input.rows,
        webContents: ctx.sender,
      });
    },

    input: async (input) => {
      return terminalService.input(input.terminalId, input.data);
    },

    resize: async (input) => {
      return terminalService.resize(input.terminalId, input.cols, input.rows);
    },

    kill: async (input) => {
      return terminalService.kill(input.terminalId);
    },
  };
}
