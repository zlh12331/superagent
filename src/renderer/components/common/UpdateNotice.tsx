// src/renderer/components/common/UpdateNotice.tsx
// 自动更新提示（AppShell 根级挂载，事件驱动 toast）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅主进程更新状态推送（useUpdate）
// - 按阶段渲染 toast：发现新版本 / 下载完成（带重启安装）/ 已是最新 / 错误
// - 下载进度不弹 toast（每秒推送，频率过高）——进度展示在关于面板与顶栏指示
//
// 设计：
// - 纯事件消费组件：不渲染 DOM（返回 null），所有提示走 sonner
// - lastPhase ref 防抖：同一阶段不重复弹（避免重复订阅/重渲染误报）
// - 快照回放（窗口重载恢复）只记阶段不弹，避免重复提示（见 use-update）
// ──────────────────────────────────────────────────────────────

import type { UpdatePhase } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
/**
 * 自动更新提示组件（挂载在 AppShell 根级，全局只此一个）
 */
export function UpdateNotice(): ReactElement | null {
  const { state, fromSnapshot, install } = useUpdate();
  // 本地化文案
  const { t } = useTranslation();
  // 用户跳过的版本（settings.update.skippedVersion）：该版本不弹提示
  const skippedVersion = useSettingsStore((s) => s.update.skippedVersion);
  // 记录上次已提示的阶段（同阶段重复推送不弹，避免干扰）
  const lastNotifiedPhaseRef = useRef<UpdatePhase | null>(null);

  useEffect(() => {
    const phase = state?.phase;
    if (phase === undefined) {
      return;
    }
    // 快照回放（窗口重载后恢复的状态）只记阶段、不重弹已提示过的通知
    if (fromSnapshot) {
      lastNotifiedPhaseRef.current = phase;
      return;
    }
    if (phase === lastNotifiedPhaseRef.current) {
      return;
    }
    lastNotifiedPhaseRef.current = phase;
    // 用户已跳过该版本：静默（顶栏徽标同样不显示）
    const version = state?.version;
    if (version !== undefined && version === skippedVersion) {
      return;
    }

    switch (phase) {
      case 'available':
        // electron-updater 默认自动下载，这里提示用户已发现新版
        toast.info(t('update.noticeAvailable'), {
          description: t('update.downloadingDesc', { version: state?.version ?? '' }),
        });
        break;
      case 'downloaded':
        toast(t('update.noticeReady'), {
          description: t('update.readyDesc', { version: state?.version ?? '' }),
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
          description: state?.message ?? t('update.unknownError'),
        });
        break;
      case 'checking':
      case 'downloading':
      case 'cancelled':
        // 检查中/下载进度/取消不做 toast（进度高频推送；取消由关于面板就地提示）
        break;
    }
  }, [state, fromSnapshot, install, skippedVersion, t]);

  return null;
}
