// notification.ts：回合完成/审批等待的系统通知挂载——仅应用完全后台（无聚焦未最小化窗口）时提醒
// 开关真源 settings.notification，发送前即时读（不缓存快照，改设置立即生效）
import { type TurnEndEvent, type TurnEvent, TurnEventType } from '@code-agent/shared/main';
import { BrowserWindow, Notification } from 'electron';

import type { IAgentService } from './infra/ai/agent/agent-service';
import type { IPermissionService } from './infra/ai/tools/permission-service';
import { readSetting } from './infra/storage/settings-pref';
import { logger } from './utils/logger';
import { showMainWindow } from './window-show';

const NOTIFY_TITLE = 'Code Agent';

// 通知设置缺失/损坏时的兜底：全开（与渲染层设置面默认一致）
const NOTIFICATION_DEFAULTS: {
  enabled: boolean;
  onTurnFinished: boolean;
  onTurnFailed: boolean;
  onApprovalRequested: boolean;
} = { enabled: true, onTurnFinished: true, onTurnFailed: true, onApprovalRequested: true };

// 逐键合并而非整体替换：设置文件部分损坏只丢单键，不至于全部通知失效
function readNotificationSettings(): {
  enabled: boolean;
  onTurnFinished: boolean;
  onTurnFailed: boolean;
  onApprovalRequested: boolean;
} {
  try {
    const value = readSetting('notification');
    if (typeof value !== 'object' || value === null) {
      return { ...NOTIFICATION_DEFAULTS };
    }
    const partial = value as Record<string, unknown>;
    const resolved = { ...NOTIFICATION_DEFAULTS };
    for (const key of Object.keys(NOTIFICATION_DEFAULTS) as ReadonlyArray<
      keyof typeof NOTIFICATION_DEFAULTS
    >) {
      const field = partial[key];
      if (typeof field === 'boolean') {
        resolved[key] = field;
      }
    }
    return resolved;
  } catch (err) {
    logger.warn({ error: String(err) }, '通知设置读取失败（按全开兜底）');
    return { ...NOTIFICATION_DEFAULTS };
  }
}

/** 回合结束是否该提醒：总开关 + 按 reason 分流（error 走 onTurnFailed，其余走 onTurnFinished） */
export function shouldNotifyTurnEnd(
  reason: TurnEndEvent['reason'],
  settings: { enabled: boolean; onTurnFinished: boolean; onTurnFailed: boolean },
): boolean {
  if (!settings.enabled) {
    return false;
  }
  return reason === 'error' ? settings.onTurnFailed : settings.onTurnFinished;
}

function describeEndReason(reason: TurnEndEvent['reason']): string {
  switch (reason) {
    case 'completed':
      return 'Agent 回合已完成';
    case 'error':
      return 'Agent 回合出错';
    case 'aborted':
      return 'Agent 回合已中断';
    case 'max-steps':
      return 'Agent 回合达到步骤上限';
  }
}

function isAppInForeground(): boolean {
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && !win.isMinimized() && win.isFocused(),
  );
}

/**
 * 挂载回合结束通知（agentService.onTurnEvent 订阅，返回 unsubscribe）
 *
 * 三道闸依次过滤：设置开关 → 应用在前台不扰民 → 平台支持；发送失败只告警不抛
 */
export function mountTurnNotifications(agentService: IAgentService): () => void {
  const unsubscribe = agentService.onTurnEvent((event: TurnEvent) => {
    if (event.type !== TurnEventType.TURN_END) {
      return;
    }
    const endEvent = event as TurnEndEvent;
    if (!shouldNotifyTurnEnd(endEvent.reason, readNotificationSettings())) {
      return;
    }
    if (isAppInForeground()) {
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    try {
      const body =
        endEvent.reason === 'completed'
          ? `回合已完成（${formatDuration(endEvent.durationMs)}）`
          : describeEndReason(endEvent.reason);
      const notification = new Notification({
        title: NOTIFY_TITLE,
        body,
        // 静默：回合结束是常态事件，提示音太吵；审批通知不静默（见下）
        silent: true,
      });
      notification.on('click', () => {
        showMainWindow();
      });
      notification.show();
    } catch (err) {
      logger.warn({ error: String(err) }, '系统通知发送失败（继续运行）');
    }
  });

  logger.info({}, 'Agent 回合系统通知已挂载（仅窗口后台时提醒）');
  return unsubscribe;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(1)} 分钟`;
  }
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/**
 * 挂载审批等待通知（permissionService 生命周期订阅；Resolved 不通知——用户就在操作这个交互）
 *
 * 同样受 settings.onApprovalRequested 与前台静默闸控制
 */
export function mountApprovalNotifications(permissionService: IPermissionService): () => void {
  const unsubscribe = permissionService.onApprovalLifecycle({
    onRequested: (payload) => {
      const settings = readNotificationSettings();
      if (!settings.enabled || !settings.onApprovalRequested) {
        return;
      }
      if (isAppInForeground()) {
        return;
      }
      if (!Notification.isSupported()) {
        return;
      }
      try {
        const notification = new Notification({
          title: NOTIFY_TITLE,
          body: `工具 ${payload.toolName} 等待审批`,
        });
        notification.on('click', () => {
          showMainWindow();
        });
        notification.show();
      } catch (err) {
        logger.warn({ error: String(err) }, '审批等待通知发送失败（继续运行）');
      }
    },
    onResolved: () => {},
  });

  logger.info({}, '审批等待系统通知已挂载（仅窗口后台时提醒）');
  return unsubscribe;
}
