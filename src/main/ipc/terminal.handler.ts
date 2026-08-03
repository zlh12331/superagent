// src/main/ipc/terminal.handler.ts
// 终端域 IPC handler（TerminalService 暴露给渲染层的入口，定义表驱动）
//
// 实现 4 个请求-响应方法：
// - create  创建终端会话，返回 terminalId
// - input   向终端写入输入（用户键入 / 粘贴命令）
// - resize  调整终端尺寸（窗口尺寸变化时调用）
// - kill    终止终端会话
//
// 流式事件由 TerminalService 主动推送（不在此 handler 返回）：
// - terminal:event:output  终端原始输出（含 ANSI 转义序列）
// - terminal:event:exit    终端进程退出
//
// 设计要点：
// - DI 模式：通过 deps 注入 ITerminalService 实例
// - create 需要使用 ctx.sender（WebContents）传给 TerminalService.create()，
//   后续输出与退出事件会通过该 webContents.send 推送回渲染层
// - handler 内不直接调用 webContents.send，所有事件推送由 TerminalService 内部处理
// - input / resize / kill 仅返回 ok 布尔值：
//   false 表示 terminalId 不存在或 pty 已退出，渲染层据此标记终端已关闭

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ITerminalService } from '../infra/terminal/terminal-service';
import type { IpcHandlerContext } from '../utils/wrap';

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
    // 创建终端会话
    // 关键：传入 ctx.sender（WebContents）作为事件推送目标，
    // 后续输出和退出事件会通过 terminal:event:* 推送到该 webContents
    // 返回 terminalId，渲染层用此 id 关联后续事件并在 input/resize/kill 时传回
    create: async (input, ctx) => {
      return terminalService.create({
        cwd: input.cwd,
        command: input.command,
        env: input.env,
        cols: input.cols,
        rows: input.rows,
        webContents: ctx.sender,
      });
    },

    // 向终端写入输入：用户键入字符或粘贴命令时调用
    // 返回 ok=true 表示写入成功；ok=false 表示 terminalId 不存在或 pty 已退出
    input: async (input) => {
      return terminalService.input(input.terminalId, input.data);
    },

    // 调整终端尺寸：渲染层窗口尺寸变化时同步 pty 尺寸
    // 返回 ok=true 表示 resize 成功；ok=false 表示 terminalId 不存在
    resize: async (input) => {
      return terminalService.resize(input.terminalId, input.cols, input.rows);
    },

    // 终止终端会话：用户关闭终端面板时调用
    // 返回 ok=true 表示 kill 信号已发送；ok=false 表示 terminalId 不存在
    // 注意：kill 后 pty 会触发 onExit 事件，主进程推送 terminal:event:exit 给渲染层
    kill: async (input) => {
      return terminalService.kill(input.terminalId);
    },
  };
}
