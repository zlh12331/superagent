import { type TurnEndEvent, type TurnEvent, TurnEventType } from '@code-agent/shared/main';
import { BrowserWindow, Notification } from 'electron';

import type { IAgentService } from './infra/ai/agent/agent-service';
import type { IPermissionService } from './infra/ai/tools/permission-service';
import { readSetting } from './infra/storage/settings-pref';
import { logger } from './utils/logger';
import { showMainWindow } from './window-show';

const NOTIFY_TITLE = 'Code Agent';

const NOTIFICATION_DEFAULTS: {
  enabled: boolean;
  onTurnFinished: boolean;
  onTurnFailed: boolean;
  onApprovalRequested: boolean;
} = { enabled: true, onTurnFinished: true, onTurnFailed: true, onApprovalRequested: true };

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
