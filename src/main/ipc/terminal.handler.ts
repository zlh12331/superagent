// src/main/ipc/terminal.handler.ts
// 终端域 IPC handler（TerminalService 暴露给渲染层的入口）
//
// 注册 4 个请求-响应 channel：
// - terminal:create  创建终端会话，返回 terminalId
// - terminal:input   向终端写入输入（用户键入 / 粘贴命令）
// - terminal:resize  调整终端尺寸（窗口尺寸变化时调用）
// - terminal:kill    终止终端会话
//
// 流式事件由 TerminalService 主动推送（不在此 handler 返回）：
// - terminal:event:output  终端原始输出（含 ANSI 转义序列）
// - terminal:event:exit    终端进程退出
//
// 设计要点：
// - 与 chat.handler.ts / file.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @novel-writer/shared，handler 不内联定义
// - terminal:create 需要使用 ctx.sender（WebContents）传给 TerminalService.create()，
//   后续输出与退出事件会通过该 webContents.send 推送回渲染层
// - handler 内不直接调用 webContents.send，所有事件推送由 TerminalService 内部处理
//   （保持 handler 简单 + 关注点分离）
// - terminal:input / resize / kill 仅返回 ok 布尔值：
//   false 表示 terminalId 不存在或 pty 已退出，渲染层据此标记终端已关闭
//

import {
  IPC_CHANNELS,
  type TerminalCreateReq,
  TerminalCreateReqSchema,
  type TerminalCreateRes,
  type TerminalInputReq,
  TerminalInputReqSchema,
  type TerminalInputRes,
  type TerminalKillReq,
  TerminalKillReqSchema,
  type TerminalKillRes,
  type TerminalResizeReq,
  TerminalResizeReqSchema,
  type TerminalResizeRes,
} from '@novel-writer/shared';
import type { ITerminalService } from '../infra/terminal/terminal-service';
import { wrap } from '../utils/wrap';

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
 * 注册终端域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerFileHandlers / registerSearchHandlers 并列。
 *
 * @param deps 依赖项：包含 ITerminalService 实例
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerTerminalHandlers(deps: TerminalHandlerDeps): void {
  const { terminalService } = deps;

  // 创建终端会话
  // 关键：传入 ctx.sender（WebContents）作为事件推送目标，
  // 后续输出和退出事件会通过 terminal:event:* 推送到该 webContents
  // 返回 terminalId，渲染层用此 id 关联后续事件并在 input/resize/kill 时传回
  wrap<TerminalCreateReq, TerminalCreateRes>(
    IPC_CHANNELS.TERMINAL_CREATE,
    TerminalCreateReqSchema,
    async (input, ctx) => {
      return terminalService.create({
        cwd: input.cwd,
        command: input.command,
        env: input.env,
        cols: input.cols,
        rows: input.rows,
        webContents: ctx.sender,
      });
    },
  );

  // 向终端写入输入：用户键入字符或粘贴命令时调用
  // 返回 ok=true 表示写入成功；ok=false 表示 terminalId 不存在或 pty 已退出
  wrap<TerminalInputReq, TerminalInputRes>(
    IPC_CHANNELS.TERMINAL_INPUT,
    TerminalInputReqSchema,
    async (input) => {
      return terminalService.input(input.terminalId, input.data);
    },
  );

  // 调整终端尺寸：渲染层窗口尺寸变化时同步 pty 尺寸
  // 返回 ok=true 表示 resize 成功；ok=false 表示 terminalId 不存在
  wrap<TerminalResizeReq, TerminalResizeRes>(
    IPC_CHANNELS.TERMINAL_RESIZE,
    TerminalResizeReqSchema,
    async (input) => {
      return terminalService.resize(input.terminalId, input.cols, input.rows);
    },
  );

  // 终止终端会话：用户关闭终端面板时调用
  // 返回 ok=true 表示 kill 信号已发送；ok=false 表示 terminalId 不存在
  // 注意：kill 后 pty 会触发 onExit 事件，主进程推送 terminal:event:exit 给渲染层
  wrap<TerminalKillReq, TerminalKillRes>(
    IPC_CHANNELS.TERMINAL_KILL,
    TerminalKillReqSchema,
    async (input) => {
      return terminalService.kill(input.terminalId);
    },
  );
}
