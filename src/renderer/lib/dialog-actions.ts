// src/renderer/lib/dialog-actions.ts
// 原生对话框 IPC 桥（dialog.pickFiles / dialog.pickDirectory）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：
// - 组件/.tsx 禁止直连 window.api；文件/目录选择器动作收敛到本文件
// - 无桥（浏览器模式 / preload 缺失）时返回 canceled 结果，不抛 TypeError
// ──────────────────────────────────────────────────────────────

import type { DialogPickDirectoryRes, DialogPickFilesRes } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 打开多选文件对话框
 *
 * @returns 无桥时视为用户取消（canceled: true），保证调用方可统一按取消分支处理
 */
export async function pickFiles(
  options: { readonly multiple?: boolean } = {},
): Promise<DialogPickFilesRes> {
  if (!hasIpcBridge()) {
    return { canceled: true };
  }
  return unwrap(
    await window.api.dialog.pickFiles({
      ...(options.multiple !== undefined ? { multiple: options.multiple } : {}),
    }),
  );
}

/**
 * 打开目录选择对话框
 *
 * @returns 无桥时视为用户取消（canceled: true）
 */
export async function pickDirectory(): Promise<DialogPickDirectoryRes> {
  if (!hasIpcBridge()) {
    return { canceled: true };
  }
  return unwrap(await window.api.dialog.pickDirectory({}));
}
