import type {
  BrowserLoadFailedPayload,
  BrowserState,
  IpcResponse,
} from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** 导航类动作响应（back/forward/reload 均返回 ok） */
export type BrowserNavRes = { readonly ok: boolean };

/**
 * 后退
 *
 * @returns IPC 原始响应；无桥时 reject（调用方可 catch 静默）
 */
export function browserBack(): Promise<IpcResponse<BrowserNavRes>> {
  if (!hasIpcBridge()) {
    return Promise.reject(new Error('[NO_BRIDGE] window.api unavailable'));
  }
  return window.api.browser.back();
}

/**
 * 前进
 */
export function browserForward(): Promise<IpcResponse<BrowserNavRes>> {
  if (!hasIpcBridge()) {
    return Promise.reject(new Error('[NO_BRIDGE] window.api unavailable'));
  }
  return window.api.browser.forward();
}

/**
 * 刷新
 */
export function browserReload(): Promise<IpcResponse<BrowserNavRes>> {
  if (!hasIpcBridge()) {
    return Promise.reject(new Error('[NO_BRIDGE] window.api unavailable'));
  }
  return window.api.browser.reload();
}

/**
 * 导航到 URL
 *
 * @throws Error 无桥或 IPC 失败
 */
export async function browserNavigate(url: string): Promise<void> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  unwrap(await window.api.browser.navigate({ url }));
}

/**
 * 拉取预览状态快照
 *
 * @throws Error 无桥或 IPC 失败
 */
export async function getBrowserState(): Promise<BrowserState> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.browser.getState());
}

/**
 * 订阅预览状态推送
 *
 * @returns unsubscribe；无桥时 no-op
 */
export function subscribeBrowserState(handler: (payload: BrowserState) => void): () => void {
  if (!hasIpcBridge()) {
    return () => {};
  }
  return window.api.browser.subscribeState(handler);
}

/**
 * 订阅主框架加载失败
 *
 * @returns unsubscribe；无桥时 no-op
 */
export function subscribeBrowserLoadFailed(
  handler: (payload: BrowserLoadFailedPayload) => void,
): () => void {
  if (!hasIpcBridge()) {
    return () => {};
  }
  return window.api.browser.subscribeLoadFailed(handler);
}
