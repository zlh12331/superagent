/**
 * Codex API — Command execution 域
 *
 * 命令执行：运行 shell 命令并获取结果。
 * 流式 PTY API：启动/写入/调整大小/终止终端会话。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * 后端命令已实现（4 个 Tauri command）：
 * - command_exec — 执行一次性命令（支持 PTY / 流式模式）
 * - command_exec_write — 向运行中的命令写入 stdin
 * - command_exec_terminate — 终止运行中的命令
 * - command_exec_resize — 调整 PTY 终端大小
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — CommandExecResult 类型
 * @see src/features/terminal/types.ts — ProcessId, TerminalOutputDelta 类型
 */

import type { UnlistenFn } from '@tauri-apps/api/event'
import { commands } from '@/lib/tauri-bindings'
import type {
  CommandExecArgs,
  CommandExecWriteArgs,
  CommandExecTerminateArgs,
  CommandExecResizeArgs,
} from '@/lib/bindings'
import type { ProcessId, TerminalOutputDelta } from '@/features/terminal/types'
import type { CommandExecResult } from './types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的命令执行数据与统一事件监听
import { getMockData, universalListen } from './mock'

/**
 * 将字符串编码为 base64（支持 UTF-8）。
 *
 * 后端 `command/exec/write` 要求 stdin 数据以 base64 编码传输。
 * 使用 TextEncoder 确保 UTF-8 字符正确编码。
 */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Tauri 响应类型（简化版，与后端 codex-rs 协议对齐）
// ---------------------------------------------------------------------------

/** command/exec 响应的 JSON 结构（简化版） */
interface CommandExecResponse {
  exitCode?: number
  stdout?: string
  stderr?: string
  durationMs?: number
}

// ---------------------------------------------------------------------------
// API 函数 — 一次性命令执行
// ---------------------------------------------------------------------------

/**
 * 执行一次性 shell 命令。
 *
 * Tauri 模式调用 `command/exec` 命令（非 PTY 模式），
 * 浏览器模式返回 mock 数据。
 *
 * @param command — 命令名称（如 `ls`）
 * @param args — 命令参数数组（如 `['-la']`）
 * @param cwd — 工作目录（可选）
 * @returns 命令执行结果
 */
export async function executeCommand(
  command: string,
  args: string[] = [],
  cwd?: string
): Promise<CommandExecResult> {
  if (isTauri()) {
    // 构建 argv 向量，codex-rs 要求 command 为非空数组
    const argv = [command, ...args]
    const reqArgs: CommandExecArgs = {
      command: argv,
      cwd: cwd ?? null,
    }
    const result = await commands.commandExec(reqArgs)
    if (result.status === 'error') {
      throw new Error(`command/exec failed: ${result.error.message}`)
    }
    const parsed: CommandExecResponse = JSON.parse(result.data)
    return {
      commandId: `cmd-${Date.now()}`,
      exitCode: parsed.exitCode ?? 0,
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
      duration: parsed.durationMs ?? 0,
    }
  }

  // 浏览器开发模式 — 返回 mock 数据
  return {
    ...getMockData().commandResult,
    commandId: `cmd-${Date.now()}`,
    stdout: `mock: ${command} ${args.join(' ')}`,
  }
}

/**
 * 获取已完成命令的执行结果。
 *
 * 后端尚未提供获取已完成命令结果的独立命令。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据
 *
 * @param _commandId — 命令 ID（后端实现后使用）
 */
export async function getCommandResult(
  _commandId: string
): Promise<CommandExecResult> {
  if (isTauri()) {
    // 后端尚未提供获取已完成命令结果的独立命令
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('getCommandResult not implemented in backend')
  }
  return getMockData().commandResult
}

/**
 * 取消正在运行的命令。
 *
 * Tauri 模式调用 `command/exec/terminate` 命令（取消 = 终止），
 * 浏览器模式为 no-op。
 *
 * @param commandId — 要取消的命令 / 进程 ID
 */
export async function cancelCommand(commandId: string): Promise<void> {
  if (isTauri()) {
    const args: CommandExecTerminateArgs = { processId: commandId }
    const result = await commands.commandExecTerminate(args)
    if (result.status === 'error') {
      throw new Error(`command/exec/terminate failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

// ---------------------------------------------------------------------------
// API 函数 — 流式 PTY 终端会话
// ---------------------------------------------------------------------------

/**
 * 启动终端会话 (PTY)。
 *
 * Tauri 模式调用 `command/exec` 命令（启用 PTY 模式），
 * 浏览器模式返回 mock 进程 ID。
 *
 * @param cwd — 工作目录
 * @param shell — shell 路径（可选，默认 `/bin/sh`）
 * @returns 进程 ID，用于后续的 write/resize/terminate 调用
 */
export async function startTerminalSession(
  cwd: string,
  shell?: string
): Promise<ProcessId> {
  if (isTauri()) {
    // 客户端生成唯一的进程 ID，用于后续的 write/resize/terminate 调用
    const processId: ProcessId = `proc-${Date.now()}`
    // 构建 shell 命令，未指定时使用 /bin/sh 作为默认 shell
    const command = shell ? [shell] : ['/bin/sh']
    const args: CommandExecArgs = {
      command,
      processId,
      tty: true,
      streamStdin: true,
      streamStdoutStderr: true,
      cwd,
    }
    const result = await commands.commandExec(args)
    if (result.status === 'error') {
      throw new Error(`command/exec (PTY) failed: ${result.error.message}`)
    }
    return processId
  }

  // 浏览器开发模式 — 返回 mock 进程 ID
  return `mock-proc-${Date.now()}`
}

/**
 * 向终端写入数据。
 *
 * Tauri 模式调用 `command/exec/write` 命令（数据以 base64 编码传输），
 * 浏览器模式为 no-op（mock 处理在 TerminalView 中）。
 *
 * @param processId — 终端会话进程 ID
 * @param data — 要写入的数据（字符串）
 * @param closeStdin — 写入后是否关闭 stdin
 */
export async function writeToTerminal(
  processId: ProcessId,
  data: string,
  closeStdin = false
): Promise<void> {
  if (isTauri()) {
    const args: CommandExecWriteArgs = {
      processId,
      deltaBase64: data ? toBase64(data) : null,
      closeStdin: closeStdin ? true : null,
    }
    const result = await commands.commandExecWrite(args)
    if (result.status === 'error') {
      throw new Error(`command/exec/write failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — mock 处理在 TerminalView 中
}

/**
 * 调整终端大小。
 *
 * Tauri 模式调用 `command/exec/resize` 命令，
 * 浏览器模式为 no-op。
 *
 * @param processId — 终端会话进程 ID
 * @param cols — 终端列数（宽度）
 * @param rows — 终端行数（高度）
 */
export async function resizeTerminalSession(
  processId: ProcessId,
  cols: number,
  rows: number
): Promise<void> {
  if (isTauri()) {
    const args: CommandExecResizeArgs = { processId, rows, cols }
    const result = await commands.commandExecResize(args)
    if (result.status === 'error') {
      throw new Error(`command/exec/resize failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 终止终端会话。
 *
 * Tauri 模式调用 `command/exec/terminate` 命令，
 * 浏览器模式为 no-op。
 *
 * @param processId — 要终止的终端会话进程 ID
 */
export async function terminateTerminalSession(
  processId: ProcessId
): Promise<void> {
  if (isTauri()) {
    const args: CommandExecTerminateArgs = { processId }
    const result = await commands.commandExecTerminate(args)
    if (result.status === 'error') {
      throw new Error(`command/exec/terminate failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 监听终端输出 (command/exec/outputDelta 事件)。
 *
 * 使用 universalListen 统一事件监听：
 * - Tauri 环境：注册原生事件监听器，接收终端输出增量数据
 * - 浏览器开发模式：注册到 mockEventBus，支持模拟终端输出
 *
 * @param callback — 输出增量回调函数
 * @returns unlisten 函数，调用后取消监听
 */
export async function onTerminalOutput(
  callback: (delta: TerminalOutputDelta) => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return await universalListen<TerminalOutputDelta>(
    'command/exec/outputDelta',
    callback
  )
}
