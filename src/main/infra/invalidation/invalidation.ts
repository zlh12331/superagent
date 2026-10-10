import type { InvalidationPayload } from '@code-agent/shared/main';
import { IPC_CHANNELS, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/**
 * 广播失效域给所有窗口（渲染层 use-invalidation-bridge 订阅后逐域前缀失效）
 *
 * @param domains 受影响域清单（元素形如 'sessions' / 'session:<id>'，取词见
 *                shared 的 INVALIDATION_DOMAINS；禁散写字面量）
 * @param sessionId 引发失效的会话 id（可选上下文；失效指令以 domains 为准）
 */
export function broadcastInvalidation(domains: readonly string[], sessionId?: string): void {
  if (domains.length === 0) {
    return;
  }
  const windows = collectWindows();
  if (windows.length === 0) {
    return;
  }
  const payload: InvalidationPayload = {
    domains,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  for (const win of windows) {
    if (!win.isDestroyed()) {
      emitEvent(win.webContents, IPC_DEFINITIONS.invalidation.subscribeDomains, payload);
    }
  }
  logger.debug(
    { domains, sessionId, channel: IPC_CHANNELS['INVALIDATION_EVENT_DOMAINS'] },
    '失效域已广播',
  );
}

/**
 * 收集存活窗口（electron 不可用时返回空数组 ⇒ 广播整体 no-op）
 *
 * 捕获范围仅限「枚举窗口」：真实运行时不会抛（BrowserWindow 恒可用）；
 * 测试环境（electron 替身缺 BrowserWindow / 未 mock 时解析为 undefined）抛错即降级。
 */
function collectWindows(): readonly BrowserWindow[] {
  try {
    return BrowserWindow.getAllWindows();
  } catch {
    return [];
  }
}
