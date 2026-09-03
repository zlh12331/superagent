// src/main/deep-link.ts
// 深度链接（自定义协议唤起）关注点
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-04 功能补齐）：桌面应用支持 `code-agent://` 协议唤起——
// 浏览器/IM 渠道（Telegram/飞书）分享链接可唤起应用并定位会话。
//
// 设计：
// - 协议：`code-agent://open/session/<id>`（定位会话）/ `code-agent://open`（仅唤起聚焦）
// - macOS：open-url 事件；Windows/Linux：second-instance 的 argv 提取
//   （Electron 在第二实例启动时把协议 URL 追加到 process.argv）
// - 统一解析 → 广播 app:event:deep-link 给全部窗口（渲染层导航）
// - 应用未启动时由 OS 直接带 URL 启动：needInstall 判断 dev 环境下的注册
//
// 平台差异：
// - macOS setAsDefaultProtocolClient 即可（Info.plist 由 electron-builder 注入 CFBundleURLTypes）
// - Windows 需 electron-builder 的 protocol 配置注册注册表 + NSIS 卸载清理
// - 单实例锁先于本模块生效：第二实例 argv 在这里消费
// ──────────────────────────────────────────────────────────────

import type { DeepLinkPayload } from '@code-agent/shared/main';

import { IPC_CHANNELS } from '@code-agent/shared/main';
import { app, BrowserWindow } from 'electron';

/** 应用自定义协议（与 electron-builder.yml 的 protocol 配置保持一致） */
export const CODE_AGENT_PROTOCOL = 'code-agent';

/**
 * 解析协议 URL → 规范化 payload
 *
 * 支持形态：
 * - code-agent://open/session/<id>  → { sessionId, url }
 * - code-agent://open?session=<id>  → { sessionId, url }（查询串兼容）
 * - code-agent://open               → { sessionId: null, url }
 * - 其它（未知 host/path）          → { sessionId: null, url }（仅唤起，不报错）
 */
export function parseDeepLink(rawUrl: string): DeepLinkPayload {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // 非 URL 形态（个别平台 argv 可能携带裸参数）：按仅唤起处理
    return { sessionId: null, url: rawUrl };
  }
  const sessionMatch = /\/session\/([^/?#]+)/.exec(url.pathname);
  const sessionId = sessionMatch?.[1] ?? url.searchParams.get('session');
  return { sessionId: sessionId ?? null, url: rawUrl };
}

/**
 * 从命令行参数提取协议 URL（second-instance argv / 冷启动 process.argv）
 *
 * Windows/Linux 下协议唤起时 argv 包含完整 `code-agent://...` URL。
 * macOS 走 open-url 事件，不走本函数。
 */
export function extractProtocolUrl(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${CODE_AGENT_PROTOCOL}://`)) ?? null;
}

/**
 * 广播深度链接事件给所有窗口
 *
 * 渲染层通过 window.api.app.subscribeDeepLink 订阅（app:event:deepLink）。
 * 无窗口时不广播（应用冷启动时 URL 由启动参数缓存在调用方）。
 */
export function broadcastDeepLink(payload: DeepLinkPayload): void {
  // IPC_CHANNELS 由 derive 生成扁平常量（key = channel 全大写，如 app:event:deepLink → APP_EVENT_DEEP_LINK）
  const channel = IPC_CHANNELS['APP_EVENT_DEEP_LINK'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * 处理一次协议唤起（无论应用是否已就绪都安全）
 *
 * @param argv 传入的 raw argv（second-instance 或冷启动 process.argv）
 * @param isColdLaunch 是否冷启动（进程刚起，窗口可能尚未创建）
 */
export function handleDeepLink(argv: readonly string[], isColdLaunch: boolean): void {
  const rawUrl = extractProtocolUrl(argv);
  if (rawUrl === null) {
    return;
  }
  const payload = parseDeepLink(rawUrl);
  if (isColdLaunch) {
    // 冷启动：窗口还不存在，推迟到 createWindow 后由 index.ts 补发
    // （实现见 index.ts：consumePendingDeepLink）
    return;
  }
  broadcastDeepLink(payload);
}

/**
 * 注册默认协议客户端
 *
 * dev 模式下首次注册不生效（Electron 的 app 名未注册协议），
 * 用 process.execPath 兜底注册，保证 pnpm dev 也能测试协议唤起。
 */
export function registerDeepLinkProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(CODE_AGENT_PROTOCOL, process.execPath, [process.argv[1] ?? '']);
  } else {
    app.setAsDefaultProtocolClient(CODE_AGENT_PROTOCOL);
  }
}
