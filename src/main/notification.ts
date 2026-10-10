import { type TurnEndEvent, type TurnEvent, TurnEventType } from '@code-agent/shared/main';
import { BrowserWindow, Notification } from 'electron';

import type { IAgentService } from './infra/ai/agent/agent-service';
import type { IPermissionService } from './infra/ai/tools/permission-service';
import { readSetting } from './infra/storage/settings-pref';
import { logger } from './utils/logger';
import { showMainWindow } from './window-show';

/** 通知标题（用户可识别为应用来源） */
const NOTIFY_TITLE = 'Code Agent';

/** 通知设置默认值（缺失/损坏字段按此补齐——「全开」向 2026-09-04 以来的恒通知行为兼容） */
const NOTIFICATION_DEFAULTS: {
  enabled: boolean;
  onTurnFinished: boolean;
  onTurnFailed: boolean;
  onApprovalRequested: boolean;
} = { enabled: true, onTurnFinished: true, onTurnFailed: true, onApprovalRequested: true };

/**
 * 读系统通知设置（app_settings/notification 键；渲染层 settings-store 写穿透落库）
 *
 * DB 值不可信：逐字段布尔收窄，损坏字段按默认补齐（部分损坏降级到部分默认）；
 * 读取异常 fail-open（返回全开）——通知是即时性提醒，静默失效比多弹一条更难察觉，
 * 但异常分支记 logger.warn 留诊断痕迹（正常路径零日志，不产生每回合噪音）。
 */
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

/**
 * 回合终止原因 → 是否弹通知（纯函数，导出供测试）
 *
 * aborted/max-steps 归「完成组」：语义是「非错误终止」（与 describeEndReason 的
 * completed/aborted/max-steps 同属回合结束告知），error 才是用户必须知道的异常态。
 */
export function shouldNotifyTurnEnd(
  reason: TurnEndEvent['reason'],
  settings: { enabled: boolean; onTurnFinished: boolean; onTurnFailed: boolean },
): boolean {
  if (!settings.enabled) {
    return false;
  }
  return reason === 'error' ? settings.onTurnFailed : settings.onTurnFinished;
}

/** 回合完成原因 → 通知文案 */
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

/** 是否有窗口获得焦点（任一可见窗口为前台 → 不打扰） */
function isAppInForeground(): boolean {
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && !win.isMinimized() && win.isFocused(),
  );
}

/**
 * 挂载 Agent 回合系统通知
 *
 * @param agentService Agent 服务（订阅回合事件）
 * @returns 卸载函数（应用退出/测试注入用）
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

/** 时长格式化（>60s 显示分钟，否则秒） */
function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(1)} 分钟`;
  }
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/**
 * 挂载审批等待系统通知（36 号 A：后台回合弹权限审批时提醒用户回来处理）
 *
 * 挂载点 = PermissionService 审批生命周期 onRequested——该回调仅在审批请求
 * **真实推送渲染层之后**触发（requestApproval 内），headless（IM 桥接）自动拒绝
 * 路径与 webContents 已销毁路径结构性地不会到这里，无需额外分支。
 *
 * 与回合结束通知的差异：
 * - 门控用 settings.notification.onApprovalRequested（第三事件开关，即时读）
 * - 不传 silent（系统默认音）：回合结束是告知（silent），审批等待是需要用户
 *   行动的 actionable 提醒——不响应 5 分钟即超时拒绝，代价高于多一声提示
 * - 点击通知 → showMainWindow（回到应用去审批，与回合通知同一映射）
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
