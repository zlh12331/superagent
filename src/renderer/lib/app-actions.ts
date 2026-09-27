// src/renderer/lib/app-actions.ts
// 应用壳层 IPC 桥（app.* / 外部打开 / 退出）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：
// - 组件/.tsx 禁止直连 window.api；app 域动作收敛到本文件（lib 层豁免）
// - AppErrorBoundary 也走此模块：保持「零 Provider / 零 hook」约束，
//   同时满足 .tsx 不直连 window.api 的一致性规则
// - 浏览器模式（无 preload）一律静默降级，不在成员访问阶段抛 TypeError
// ──────────────────────────────────────────────────────────────

import type { AppInfoRes } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 拉取应用信息（版本/平台/路径）
 *
 * @throws Error 无桥、IPC 错误响应或协议异常时抛出（调用方自行兜底）
 */
export async function fetchAppInfo(): Promise<AppInfoRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.app.getInfo());
}

/**
 * 用系统默认程序打开 URL / 路径（主进程侧有协议白名单校验）
 *
 * @returns 是否已发起（无桥时 false，不抛错）
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!hasIpcBridge()) {
    return false;
  }
  unwrap(await window.api.app.openExternal({ url }));
  return true;
}

/**
 * 打开用户数据目录
 *
 * @returns 是否已发起（无桥时 false，不抛错）
 */
export async function openDataDir(): Promise<boolean> {
  if (!hasIpcBridge()) {
    return false;
  }
  unwrap(await window.api.app.openDataDir());
  return true;
}

/**
 * 退出应用（走完整善后链：before-quit 协商 → dispose → 延迟安装）
 *
 * @returns 是否已发起（无桥时 false）
 */
export function quitApp(): boolean {
  if (!hasIpcBridge()) {
    return false;
  }
  void window.api.app.quit();
  return true;
}
