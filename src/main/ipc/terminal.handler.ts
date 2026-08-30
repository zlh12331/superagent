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
//
// ── 安全边界：为什么终端不做工作区路径收口（与 file:* 的关键差异）──────
// file:* 的语义是「程序替用户读写某个路径」，渲染层可在用户无感知时静默读写
// 任意磁盘文件，所以必须在 handler 层收口到工作区（见 file.handler.ts）。
// terminal:create 的语义是「给用户开一个交互式 shell」：
// 1. 由用户主动点「新建终端」触发，命令由用户键入/粘贴，输出全量回显——
//    没有「静默执行」的余地；
// 2. 收口 cwd 无收益：交互 shell 里一条 `cd /` 就出去了。真正的边界是
//    「是否允许执行任意命令」，那归审批模式管（terminal 工具 permission:'ask'
//    + category:'exec' + Layer-0 危险命令检测），不是路径守卫能解决的；
// 3. 强行限制 cwd 会破坏集成终端既有用法（用户可选任意目录开终端）。
// 因此这里只加两条不影响合法用途的约束：
// - env 不得覆盖系统关键变量（PATH/PATHEXT/LD_PRELOAD/NODE_OPTIONS…）：
//   否则可用「开终端」这个用户动作劫持其后续执行的每一条命令。
//   IPC 边界由 TerminalCreateReqSchema.superRefine 直接拒绝（类型化错误），
//   TerminalService 再过滤一次（防绕过 IPC 的内部调用方）。
// - cwd 必须真实存在且是目录：spawn 不存在的目录时 node-pty 抛的是无上下文的
//   spawn 失败，这里转成类型化 NOT_FOUND / INVALID_INPUT。
// ──────────────────────────────────────────────────────────────

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
    // 创建终端会话
    // 关键：传入 ctx.sender（WebContents）作为事件推送目标，
    // 后续输出和退出事件会通过 terminal:event:* 推送到该 webContents
    // 返回 terminalId，渲染层用此 id 关联后续事件并在 input/resize/kill 时传回
    create: async (input, ctx) => {
      // P2 加固：显式传入的 cwd 必须是真实目录（省略时由 service 兜底用户主目录）
      if (input.cwd !== undefined) {
        assertExistingDirectory(input.cwd);
      }
      return terminalService.create({
        // P3 修复：cwd 可选——渲染层传激活会话 workingDir；未传时
        // TerminalService 回退到用户主目录（不再硬编码项目路径）
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
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
