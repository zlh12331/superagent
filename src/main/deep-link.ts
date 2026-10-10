import type { DeepLinkPayload } from '@code-agent/shared/main';

import { IPC_CHANNELS } from '@code-agent/shared/main';
import { app, BrowserWindow } from 'electron';

export const CODE_AGENT_PROTOCOL = 'code-agent';

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

export function extractProtocolUrl(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${CODE_AGENT_PROTOCOL}://`)) ?? null;
}

export function broadcastDeepLink(payload: DeepLinkPayload): void {
  const channel = IPC_CHANNELS['APP_EVENT_DEEP_LINK'];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

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

export function registerDeepLinkProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(CODE_AGENT_PROTOCOL, process.execPath, [process.argv[1] ?? '']);
  } else {
    app.setAsDefaultProtocolClient(CODE_AGENT_PROTOCOL);
  }
}
