// src/renderer/lib/terminal-actions.ts
// 终端 IPC 桥（create / kill / input / resize / 订阅）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：
// - TerminalView / TerminalPanel 此前直连 window.api.terminal.*，收敛到本文件
// - 订阅函数返回 unsubscribe，生命周期由组件 effect 管理
// - 无桥（浏览器模式）时返回明确空结果 / no-op unsubscribe，不抛 TypeError
// ──────────────────────────────────────────────────────────────

import type {
  TerminalCreateReq,
  TerminalCreateRes,
  TerminalExitEventPayload,
  TerminalKillReq,
  TerminalOutputEventPayload,
} from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 创建终端（node-pty）
 *
 * @throws Error 无桥或 IPC 失败（消息带 [CODE] 前缀）
 */
export async function createTerminal(params: TerminalCreateReq): Promise<TerminalCreateRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.terminal.create(params));
}

/**
 * 结束终端进程
 *
 * @throws Error 无桥或 IPC 失败
 */
export async function killTerminal(params: TerminalKillReq): Promise<void> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  unwrap(await window.api.terminal.kill(params));
}

/**
 * 向终端写入用户输入
 *
 * @returns 是否已发送（无桥 false，不抛错——高频输入路径）
 */
export function writeTerminalInput(terminalId: string, data: string): boolean {
  if (!hasIpcBridge()) {
    return false;
  }
  void window.api.terminal.input({ terminalId, data });
  return true;
}

/**
 * 同步终端尺寸到 PTY
 *
 * @returns 是否已发送（无桥 false，不抛错——高频 resize 路径）
 */
export function resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
  if (!hasIpcBridge()) {
    return false;
  }
  void window.api.terminal.resize({ terminalId, cols, rows });
  return true;
}

/**
 * 订阅终端输出事件
 *
 * @returns unsubscribe；无桥时返回 no-op
 */
export function subscribeTerminalOutput(
  handler: (payload: TerminalOutputEventPayload) => void,
): () => void {
  if (!hasIpcBridge()) {
    return () => {};
  }
  return window.api.terminal.subscribeOutputEvent(handler);
}

/**
 * 订阅终端退出事件
 *
 * @returns unsubscribe；无桥时返回 no-op
 */
export function subscribeTerminalExit(
  handler: (payload: TerminalExitEventPayload) => void,
): () => void {
  if (!hasIpcBridge()) {
    return () => {};
  }
  return window.api.terminal.subscribeExitEvent(handler);
}
