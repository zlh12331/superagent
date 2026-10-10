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
