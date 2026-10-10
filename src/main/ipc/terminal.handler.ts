// terminal.handler.ts：terminal 域 IPC——创建/输入/改尺寸/杀终端（输出流经 terminal:stream 事件推送）
import { statSync } from 'node:fs';
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import type { ITerminalService } from '../infra/terminal/terminal-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** cwd 前置校验（同步 stat 够用）：node-pty 对不存在目录 spawn 会挂起而非报错，必须先拦 */
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

/** 依赖注入工厂：index.ts 传入 terminalService */
export interface TerminalHandlerDeps {
  readonly terminalService: ITerminalService;
}

/** 依赖注入工厂 */
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
