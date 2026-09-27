// src/renderer/lib/task-actions.ts
// 计划待办 IPC 桥（task:list）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：right-panel-panes 不再直连 window.api
// ──────────────────────────────────────────────────────────────

import type { TaskListRes } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 拉取会话计划待办列表
 *
 * @returns 无桥时返回空列表（右面板可渲染空态）
 */
export async function fetchTaskList(sessionId?: string): Promise<TaskListRes> {
  if (!hasIpcBridge()) {
    return { tasks: [] };
  }
  return unwrap(
    await window.api.task.list({
      ...(sessionId !== undefined ? { sessionId } : {}),
    }),
  );
}
