// src/renderer/hooks/use-terminal-bridge.ts
// 终端 IPC 桥接 Hook（L4 流式推送层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 terminal:event:output / terminal:event:exit IPC 事件
// - 将输出/退出事件写入 useTerminalStore，供 TerminalPanel 渲染
//
// 设计：
// - 在 AppShell 根布局初始化一次，保证任意路由下都能接收终端事件
// - 与 use-tool-bridge 类似的桥接模式：IPC 事件 → Zustand store
// - 不处理 UI 展示（由 TerminalPanel 组件订阅 store 渲染）
//
// 事件处理：
// - terminal:event:output 携带 { terminalId, data }
//   data 为原始 ANSI 字符串，按「行」切分后追加到 buffer
//   （切分策略：保留末尾不完整行至下次合并，避免行尾闪烁；
//    简化实现：按 \n split，末尾若不为空则作为单独「未完成行」暂存）
// - terminal:event:exit 携带 { terminalId, exitCode, signal? }
//   仅标记终端已退出（alive=false），不删除 buffer（保留历史输出供查看）
//
// 性能考虑：
// - 高频输出（如 ls -la 大目录）会触发大量 set 调用
// - 当前实现：每个 output 事件触发一次 set，依赖 zustand 浅比较 + 环形截断
// - 若后续出现性能瓶颈，可改为 requestAnimationFrame 批量合并
// ──────────────────────────────────────────────────────────────

import type { TerminalExitEventPayload, TerminalOutputEventPayload } from '@novel-writer/shared';
import { useEffect } from 'react';

import { useTerminalStore } from '@/stores/transient/terminal-store';

/**
 * 终端 IPC 桥接 Hook
 *
 * 在根布局（AppShell）调用一次，订阅 IPC 终端事件并写入 store。
 *
 * @example
 * ```tsx
 * function AppShell() {
 *   useTerminalBridge();
 *   // ...
 * }
 * ```
 */
export function useTerminalBridge(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) return;

    // 订阅终端输出事件：主进程推送 PTY 原始输出（含 ANSI 转义序列）
    // 渲染层由 TerminalPanel 用 xterm.js 直接 write，不解码
    // 此处仅写入 buffer 作为兜底（用于组件卸载重挂时恢复可见内容）
    const unsubscribeOutput = window.api.terminal.subscribeOutputEvent((payload) => {
      const typedPayload = payload as TerminalOutputEventPayload;
      // data 通常是「一行 + \n」或「部分行（无 \n）」
      // 简化策略：按 \n 切分，保留所有完整行 + 末尾未完成行
      // xterm.js 渲染不依赖此切分，此处仅用于 buffer 兜底
      const lines = typedPayload.data.split('\n');
      // 若末尾为空字符串（即 data 以 \n 结尾），移除空字符串避免多一个空行
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      useTerminalStore.getState().appendOutput(typedPayload.terminalId, lines);
    });

    // 订阅终端退出事件：PTY 进程结束（用户输入 exit 或被 kill）
    // 标记 alive=false，UI 显示为已结束状态，但保留输出 buffer 供查看
    const unsubscribeExit = window.api.terminal.subscribeExitEvent((payload) => {
      const typedPayload = payload as TerminalExitEventPayload;
      useTerminalStore.getState().markExited(typedPayload.terminalId);
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, []);
}
