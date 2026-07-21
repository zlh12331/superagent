// src/renderer/hooks/use-tool-bridge.ts
// 工具调用 IPC 桥接 Hook
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 agent:tool:call / agent:tool:result IPC 事件
// - 将事件 payload 转换为 ToolCallItem 并写入 useToolStore
// - 提供清空指定会话工具调用的方法（切换会话时调用）
//
// 设计：
// - 在 AppShell 根布局初始化一次，保证任意路由下都能接收工具事件
// - 与 use-approval-bridge 类似的桥接模式：IPC 事件 → Zustand store
// - 不处理 UI 展示（由 ToolPanel 组件订阅 store 渲染）
//
// 事件配对：
// - agent:tool:call 携带 { sessionId, toolCallId, toolName, input, permission }
// - agent:tool:result 携带 { sessionId, toolCallId, toolName, output, error? }
// - 主进程保证配对推送：每个 tool:call 必有对应 tool:result（成功或失败）
// ──────────────────────────────────────────────────────────────

import type { AgentToolCallPayload, AgentToolResultPayload } from '@novel-writer/shared';
import { useEffect } from 'react';

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
    if (typeof window === 'undefined' || window.api === undefined) return;

    // 订阅工具调用事件：主进程推送工具调用入参与权限级别
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

    // 订阅工具结果事件：主进程推送工具执行结果（含 output 或 error）
    const unsubscribeToolResult = window.api.agent.subscribeToolResult((payload) => {
      const typedPayload = payload as AgentToolResultPayload;
      useToolStore.getState().appendToolResult(typedPayload.toolCallId, {
        output: typedPayload.output,
        error: typedPayload.error ?? null,
      });
    });

    return () => {
      unsubscribeToolCall();
      unsubscribeToolResult();
    };
  }, []);
}
