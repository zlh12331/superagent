// src/main/infra/invalidation/invalidation.ts
// 失效域广播：主进程写路径声明式通知渲染层缓存失效（docs/design/31-invalidation-automation-spec.md）
// ──────────────────────────────────────────────────────────────
// 背景：失效的「知识」此前长在消费端（use-agent-bridge 硬编码清单，task/usage/
// git/file/turns 五连遗漏的由来）。本模块把通知权交还写入端——各写路径调
// broadcastInvalidation(domains, sessionId?) 声明受影响域，渲染层事件桥
// （use-invalidation-bridge）逐域前缀失效。
//
// 广播形态对齐先例（deep-link.ts:66-74 / main-events.ts）：
// 遍历 BrowserWindow.getAllWindows() + isDestroyed() 守卫 + webContents.send。
// 发送复用 emitEvent（utils/emit-event.ts）：免费获得 dev 侧 payload 契约校验与
// webContents 销毁守卫，不另造第二套发送路径。
//
// electron 访问为何包 try/catch（对齐 emit-event.ts 的 app.isPackaged 先例）：
// 本模块被 session-service / agent-service / memory-hub / im-service 四条链传递性
// import，其单测与集成测试运行在 electron 替身未提供 BrowserWindow 的环境——
// 访问缺失成员会抛错。此处捕获后降级为 no-op：广播在「无窗口」下本就该是 no-op
// （deep-link.ts:64 同语义），同时让下游既有测试零 mock 透传；广播行为本身由本
// 模块专属单测（vi.mock electron 捕获 send）严格覆盖。
// ──────────────────────────────────────────────────────────────

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
  // exactOptionalPropertyTypes：sessionId 缺省时不携带字段（条件展开）
  const payload: InvalidationPayload = {
    domains,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  for (const win of windows) {
    // 先判窗口再取 webContents：销毁窗口上访问 webContents 会抛 "Object has been destroyed"
    // （deep-link.ts 同款守卫）；emitEvent 内还有 webContents 级守卫，双保险不重复日志
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
