import type { UpdateStatusPayload } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/** toast 文案函数类型（从 useTranslation 返回值反推，避免手抄 TFunction 泛型） */
type Translate = ReturnType<typeof useTranslation>['t'];

/**
 * 阶段 → toast 分派（模块级纯函数）
 *
 * checking/downloading/cancelled 静默：进度高频推送（展示在关于面板与顶栏指示）；
 * 取消由关于面板就地提示。
 */
function notifyPhase(payload: UpdateStatusPayload, install: () => void, t: Translate): void {
  const { phase, version, message } = payload;
  switch (phase) {
    case 'available':
      toast.info(t('update.noticeAvailable'), {
        description: t('update.downloadingDesc', { version: version ?? '' }),
      });
      break;
    case 'downloaded':
      toast(t('update.noticeReady'), {
        description: t('update.readyDesc', { version: version ?? '' }),
        action: {
          label: t('update.restartNow'),
          onClick: install,
        },
        duration: 60_000,
      });
      break;
    case 'not-available':
      toast.success(t('update.upToDate'));
      break;
    case 'error':
      toast.error(t('update.checkFailed'), {
        description: message ?? t('update.unknownError'),
      });
      break;
    case 'checking':
    case 'downloading':
    case 'cancelled':
      break;
  }
}

/**
 * 自动更新提示组件（挂载在 AppShell 根级，全局只此一个）
 */
export function UpdateNotice(): ReactElement | null {
  const { state, fromSnapshot, install } = useUpdate();
  const { t } = useTranslation();
  const skippedVersion = useSettingsStore((s) => s.update.skippedVersion);
  const lastNotifiedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (state === null) {
      return;
    }
    const { phase, version } = state;
    const dedupKey = version !== undefined ? `${phase}@${version}` : phase;
    if (fromSnapshot) {
      lastNotifiedKeyRef.current = dedupKey;
      return;
    }
    if (dedupKey === lastNotifiedKeyRef.current) {
      return;
    }
    lastNotifiedKeyRef.current = dedupKey;
    if (version !== undefined && version === skippedVersion) {
      return;
    }
    notifyPhase(state, install, t);
  }, [state, fromSnapshot, install, skippedVersion, t]);

  return null;
}
