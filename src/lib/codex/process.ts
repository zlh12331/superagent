/**
 * Codex API — Process 域
 *
 * 进程管理：启动主机进程、写入 stdin、终止、调整 PTY 大小。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * 后端命令已实现（4 个 Tauri command）：
 * - process_spawn — 在主机上启动独立进程（不经过 Codex 沙箱）
 * - process_writeStdin — 向运行中的进程写入 stdin
 * - process_kill — 终止运行中的进程
 * - process_resizePty — 调整 PTY 终端大小
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — ProcessInfo 类型
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  ProcessSpawnArgs,
  ProcessWriteStdinArgs,
  ProcessKillArgs,
  ProcessResizePtyArgs,
} from '@/lib/bindings'
import type { ProcessInfo } from './types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的进程列表数据源
import { getMockData } from './mock'

/**
 * 将字符串编码为 base64（支持 UTF-8）。
 *
 * 后端 `process/writeStdin` 要求 stdin 数据以 base64 编码传输。
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
// API 函数 — 进程管理（process 域 4 个命令）
// ---------------------------------------------------------------------------

/**
 * 启动独立进程。
 *
 * Tauri 模式调用 `process/spawn` 命令（在主机上直接执行，不经过 Codex 沙箱），
 * 浏览器模式为 no-op。
 *
 * 与 `command/exec` 不同，此命令不经过 Codex 沙箱。
 * `processHandle` 由客户端提供，用于后续的 writeStdin/kill/resizePty 调用。
 *
 * @param command — 命令 argv 向量（如 `['node', 'server.js']`，必填）
 * @param processHandle — 客户端提供的进程句柄（必填，用于后续调用）
 * @param cwd — 绝对工作目录（必填）
 * @param options — 可选参数（tty、streamStdin、streamStdoutStderr）
 */
export async function spawnProcess(
  command: string[],
  processHandle: string,
  cwd: string,
  options?: {
    tty?: boolean
    streamStdin?: boolean
    streamStdoutStderr?: boolean
  }
): Promise<void> {
  if (isTauri()) {
    const args: ProcessSpawnArgs = {
      command,
      processHandle,
      cwd,
      tty: options?.tty ?? null,
      streamStdin: options?.streamStdin ?? null,
      streamStdoutStderr: options?.streamStdoutStderr ?? null,
    }
    const result = await commands.processSpawn(args)
    if (result.status === 'error') {
      throw new Error(`process/spawn failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 向运行中的进程写入 stdin 数据。
 *
 * Tauri 模式调用 `process/writeStdin` 命令（数据以 base64 编码传输），
 * 浏览器模式为 no-op。
 *
 * @param processHandle — 进程句柄（必填）
 * @param data — 要写入的数据（字符串，将被 base64 编码）
 * @param closeStdin — 写入后是否关闭 stdin
 */
export async function writeProcessStdin(
  processHandle: string,
  data: string,
  closeStdin = false
): Promise<void> {
  if (isTauri()) {
    const args: ProcessWriteStdinArgs = {
      processHandle,
      deltaBase64: data ? toBase64(data) : null,
      closeStdin: closeStdin ? true : null,
    }
    const result = await commands.processWriteStdin(args)
    if (result.status === 'error') {
      throw new Error(`process/writeStdin failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 终止运行中的进程。
 *
 * Tauri 模式调用 `process/kill` 命令，
 * 浏览器模式为 no-op。
 *
 * @param processHandle — 要终止的进程句柄（必填）
 */
export async function killProcess(processHandle: string): Promise<void> {
  if (isTauri()) {
    const args: ProcessKillArgs = { processHandle }
    const result = await commands.processKill(args)
    if (result.status === 'error') {
      throw new Error(`process/kill failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 调整 PTY 终端大小。
 *
 * Tauri 模式调用 `process/resizePty` 命令，
 * 浏览器模式为 no-op。
 *
 * @param processHandle — 要调整大小的进程句柄（必填）
 * @param rows — 终端行数（高度）
 * @param cols — 终端列数（宽度）
 */
export async function resizeProcessPty(
  processHandle: string,
  rows: number,
  cols: number
): Promise<void> {
  if (isTauri()) {
    const args: ProcessResizePtyArgs = { processHandle, rows, cols }
    const result = await commands.processResizePty(args)
    if (result.status === 'error') {
      throw new Error(`process/resizePty failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

// ---------------------------------------------------------------------------
// 以下函数的后端命令尚未实现，保留 mock + TODO 标记
// ---------------------------------------------------------------------------

/**
 * 列出运行中的进程。
 *
 * 后端尚未实现进程列表查询 API。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据
 *
 * @returns 进程信息列表
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  if (isTauri()) {
    // 后端尚未实现进程管理 API
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('listProcesses not implemented in backend')
  }
  return getMockData().processes
}

/**
 * 获取单个进程信息。
 *
 * 后端尚未实现进程信息查询 API。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据
 *
 * @param _pid — 进程 PID（后端实现后使用）
 * @returns 进程信息，或 null（不存在时）
 */
export async function getProcessInfo(_pid: number): Promise<ProcessInfo | null> {
  if (isTauri()) {
    // 后端尚未实现进程管理 API
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('getProcessInfo not implemented in backend')
  }
  return getMockData().processes[0] ?? null
}
