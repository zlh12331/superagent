import type {
  TerminalExitEventPayload,
  TerminalOutputEventPayload,
} from '@code-agent/shared/renderer';
import { useEffect } from 'react';
import { hasIpcBridge } from '@/lib/ipc';
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
    if (!hasIpcBridge()) return;

    const unsubscribeOutput = window.api.terminal.subscribeOutputEvent((payload) => {
      const typedPayload = payload as TerminalOutputEventPayload;
      useTerminalStore.getState().appendOutput(typedPayload.terminalId, typedPayload.data);
    });

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
