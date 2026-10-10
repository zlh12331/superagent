import type { AgentToolCallPayload, AgentToolResultPayload } from '@code-agent/shared/renderer';
import { useEffect } from 'react';
import { hasIpcBridge } from '@/lib/ipc';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { useToolStore } from '@/stores/transient/tool-store';

/**
 * 工具调用 IPC 桥接 Hook
 *
 * 在根布局（AppShell）调用一次，订阅 IPC 工具事件并写入 store。
 * 返回清空方法，供切换会话时调用。
 *
 * @example
 * ```tsx
 * function AppShell() {
 *   useToolBridge();
 *   // ...
 * }
 * ```
 */
export function useToolBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) return;

    const unsubscribeToolCall = window.api.agent.subscribeToolCall((payload) => {
      const typedPayload = payload as AgentToolCallPayload;
      useToolStore.getState().appendToolCall({
        id: typedPayload.toolCallId,
        sessionId: typedPayload.sessionId,
        toolName: typedPayload.toolName,
        input: typedPayload.input,
        permission: typedPayload.permission,
      });
    });

    const unsubscribeToolResult = window.api.agent.subscribeToolResult((payload) => {
      const typedPayload = payload as AgentToolResultPayload;
      useToolStore.getState().appendToolResult(typedPayload.toolCallId, {
        output: typedPayload.output,
        error: typedPayload.error ?? null,
        ...(typedPayload.title !== undefined ? { title: typedPayload.title } : {}),
      });

      if (
        typedPayload.toolName === 'terminal' &&
        typedPayload.metadata !== undefined &&
        typedPayload.metadata !== null &&
        typeof typedPayload.metadata === 'object' &&
        'action' in typedPayload.metadata &&
        (typedPayload.metadata as Record<string, unknown>)['action'] === 'create' &&
        'terminalId' in typedPayload.metadata
      ) {
        const meta = typedPayload.metadata as Record<string, unknown>;
        const terminalId = String(meta['terminalId']);
        const sessionId = typedPayload.sessionId;
        const existing = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);
        if (existing === undefined) {
          useTerminalStore.getState().createTerminal({
            id: terminalId,
            sessionId,
            title: typeof meta['title'] === 'string' ? meta['title'] : 'shell',
            pid: typeof meta['pid'] === 'number' ? meta['pid'] : null,
            cwd: typeof meta['cwd'] === 'string' ? meta['cwd'] : '',
            alive: true,
          });
        }
      }
    });

    return () => {
      unsubscribeToolCall();
      unsubscribeToolResult();
    };
  }, []);
}
