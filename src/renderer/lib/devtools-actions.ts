// src/renderer/lib/devtools-actions.ts
// DevTools 打开动作 IPC 桥
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：InspectorPanel 不再直连 window.api
// ──────────────────────────────────────────────────────────────

import type { OpenDevToolsRes } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** DevTools 停靠模式（与 shared OpenDevToolsReq.mode 对齐） */
export type DevToolsDockMode = 'detach' | 'right' | 'bottom';

/**
 * 打开 Chromium DevTools（指定停靠模式）
 *
 * @throws Error 无桥或 IPC 失败
 */
export async function openDevTools(mode: DevToolsDockMode): Promise<OpenDevToolsRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.devtools.open({ mode }));
}
