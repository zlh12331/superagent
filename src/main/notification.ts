// src/main/notification.ts
// 系统通知关注点（Agent 回合完成后台提醒）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-04 功能补齐）：Agent 回合在后台运行时（用户最小化/切换走），
// 回合完成/出错没有提示——用户切走后漏掉结果。成熟桌面应用（Slack/1Password）
// 在"窗口不可见 + 后台事件"时用系统通知提醒。
//
// 设计：
// - 订阅 AgentService.onTurnEvent 的 TURN_END 事件（错误后必跟 turn-end reason='error'，
//   单事件覆盖全部终止路径）
// - 用户设置门控（2026-09-29，33 号 spec）：settings.notification 三开关（总开关 +
//   完成/出错两组事件开关），发送前即时读 app_settings，缺失/损坏按全开兜底
// - 仅当应用窗口不可见（无窗口获得焦点）时发通知——前台用户看得到结果，
//   重复弹通知是打扰（对齐行业惯例：Slack 只在窗口失焦时弹桌面通知）
// - 文案按 reason 区分：completed（完成）/ error（失败）/ aborted（被中断）
// - 通知点击聚焦窗口（用户点通知回到应用的常规映射）
// - 平台差异由 Electron Notification 封装；Linux 需 libnotify（AppImage 自带）
// - 审批等待通知（2026-09-30，36 号 A）：订阅 PermissionService 审批生命周期，
//   后台弹审批时提醒用户回来处理（onApprovalRequested 事件开关）
// ──────────────────────────────────────────────────────────────

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
    // 只关心末尾事件（回合结束 / 错误）；错误后必跟 turn-end reason='error'，
    // 本处只需 TURN_END 即可覆盖全部终止路径——避免重复弹窗
    if (event.type !== TurnEventType.TURN_END) {
      return;
    }
    const endEvent = event as TurnEndEvent;
    // 用户设置门控（33 号）：发送前即时读（无缓存，渲染层写穿透落库即生效）；
    // 前台/能力检查在设置检查之后——设置关闭时连 isSupported 查询都省掉
    if (!shouldNotifyTurnEnd(endEvent.reason, readNotificationSettings())) {
      return;
    }
    // 前台有焦点 → 用户正在看，不弹（避免打扰）
    if (isAppInForeground()) {
      return;
    }
    // 系统通知不可用（Linux 无 libnotify 等）静默跳过
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
        // 回合结束默认静音不打扰（桌面 Agent 告知结果的轻柔语义；
        // 用户可自行在系统通知中心关闭）
        silent: true,
      });
      // 点击通知 → 把主窗口带到眼前（用户点通知回到应用的常规映射）
      // 用 window-show 的唯一实现：本处原为 restore → show → focus 的第三份副本，
      // 已并入 showMainWindow（含"静默启动后首次唤回时恢复最大化"的处理）
      notification.on('click', () => {
        showMainWindow();
      });
      notification.show();
    } catch (err) {
      // 通知失败（构造异常等）非致命：记录后继续运行
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
      // 用户设置门控（36-A）：发送前即时读；前台/能力检查在设置检查之后
      const settings = readNotificationSettings();
      if (!settings.enabled || !settings.onApprovalRequested) {
        return;
      }
      // 前台有焦点 → 审批弹窗用户可见，不弹（避免打扰）
      if (isAppInForeground()) {
        return;
      }
      // 系统通知不可用（Linux 无 libnotify 等）静默跳过
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
        // 通知失败（构造异常等）非致命：记录后继续运行
        logger.warn({ error: String(err) }, '审批等待通知发送失败（继续运行）');
      }
    },
    onResolved: () => {
      // 审批决议无需通知（用户刚操作完或超时——超时后由回合出错通知覆盖）
    },
  });

  logger.info({}, '审批等待系统通知已挂载（仅窗口后台时提醒）');
  return unsubscribe;
}
