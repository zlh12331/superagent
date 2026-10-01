// notification-section.tsx（自 general-section 子区提取）
// 设置 · 系统通知（回合结束后台提醒门控，33 号 spec；审批等待提醒 36 号 A）
// ──────────────────────────────────────────────
// 设计：四开关组（总开关 + 完成/出错/审批等待三组事件开关），总开关关闭时
// 事件开关禁用（值保留，恢复后原值生效——V9）。写穿透经 settings-store 落
// SQLite，主进程发送通知前即时读取，无需重启（V8 同链路）。
// ──────────────────────────────────────────────

import { Bell } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { ToggleRow } from '../settings-controls';

/** 系统通知区块（驻留行为域：与关窗语义/开机自启相邻） */
export function NotificationSection(): ReactElement {
  const { t } = useTranslation();
  const notification = useSettingsStore((s) => s.notification);
  const updateNotification = useSettingsStore((s) => s.updateNotification);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Bell className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.notificationTitle')}</h3>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <ToggleRow
          name={t('settings.notificationLabel')}
          description={t('settings.notificationDesc')}
          checked={notification.enabled}
          onChange={(checked) => updateNotification({ enabled: checked })}
        />
        <ToggleRow
          name={t('settings.notificationFinishedLabel')}
          description={
            notification.enabled
              ? t('settings.notificationFinishedDesc')
              : t('settings.notificationDisabledDesc')
          }
          checked={notification.onTurnFinished}
          disabled={!notification.enabled}
          onChange={(checked) => updateNotification({ onTurnFinished: checked })}
        />
        <ToggleRow
          name={t('settings.notificationFailedLabel')}
          description={
            notification.enabled
              ? t('settings.notificationFailedDesc')
              : t('settings.notificationDisabledDesc')
          }
          checked={notification.onTurnFailed}
          disabled={!notification.enabled}
          onChange={(checked) => updateNotification({ onTurnFailed: checked })}
        />
        {/* 审批等待（36 号 A）：后台回合弹权限审批时提醒，避免任务静默卡到超时 */}
        <ToggleRow
          name={t('settings.notificationApprovalLabel')}
          description={
            notification.enabled
              ? t('settings.notificationApprovalDesc')
              : t('settings.notificationDisabledDesc')
          }
          checked={notification.onApprovalRequested}
          disabled={!notification.enabled}
          onChange={(checked) => updateNotification({ onApprovalRequested: checked })}
        />
      </div>
    </div>
  );
}
