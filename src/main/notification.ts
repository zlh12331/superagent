// src/main/notification.ts
// 系统通知关注点（Agent 回合完成后台提醒）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-04 功能补齐）：Agent 回合在后台运行时（用户最小化/切换走），
// 回合完成/出错没有提示——用户切走后漏掉结果。成熟桌面应用（Slack/1Password）
// 在"窗口不可见 + 后台事件"时用系统通知提醒。
//
// 设计：
// - 订阅 AgentService.onTurnEvent 的 TURN_END / ERROR 事件
// - 仅当应用窗口不可见（无窗口获得焦点）时发通知——前台用户看得到结果，
//   重复弹通知是打扰（对齐行业惯例：Slack 只在窗口失焦时弹桌面通知）
// - 文案按 reason 区分：completed（完成）/ error（失败）/ aborted（被中断）
// - 通知点击聚焦窗口（用户点通知回到应用的常规映射）
// - 平台差异由 Electron Notification 封装；Linux 需 libnotify（AppImage 自带）
// ──────────────────────────────────────────────────────────────

import { type TurnEndEvent, type TurnEvent, TurnEventType } from '@code-agent/shared/main';
import { BrowserWindow, Notification } from 'electron';

import type { IAgentService } from './infra/ai/agent/agent-service';
import { logger } from './utils/logger';

/** 通知标题（用户可识别为应用来源） */
const NOTIFY_TITLE = 'Code Agent';

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
      // 点击通知 → 聚焦主窗口（用户点通知回到应用）
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win !== undefined && !win.isDestroyed()) {
          if (win.isMinimized()) {
            win.restore();
          }
          win.show();
          win.focus();
        }
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
