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
// - 去重键 phase@version 防抖：同阶段同版本不重复弹（快照回放后同阶段新版本仍能弹出）
// - 快照回放（窗口重载恢复）只记键不弹，避免重复提示（见 use-update）
// - 阶段 → toast 的分派在模块级 notifyPhase：effect 只做去重与守卫（认知复杂度棘轮）
// ──────────────────────────────────────────────────────────────

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
      // electron-updater 默认自动下载，这里提示用户已发现新版
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
  // 本地化文案
  const { t } = useTranslation();
  // 用户跳过的版本（settings.update.skippedVersion）：该版本不弹提示
  const skippedVersion = useSettingsStore((s) => s.update.skippedVersion);
  // 记录上次已提示的去重键「phase@version」（version 缺失时退化为 phase）。
  // 键必须含版本：快照回放记下 available@1.2.0 后，若重检查发现 1.2.1 并以
  // 同阶段 available 实时推送，仅按 phase 去重会把新版本提示误吞
  const lastNotifiedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (state === null) {
      return;
    }
    const { phase, version } = state;
    const dedupKey = version !== undefined ? `${phase}@${version}` : phase;
    // 快照回放（窗口重载后恢复的状态）只记键、不重弹已提示过的通知
    if (fromSnapshot) {
      lastNotifiedKeyRef.current = dedupKey;
      return;
    }
    if (dedupKey === lastNotifiedKeyRef.current) {
      return;
    }
    lastNotifiedKeyRef.current = dedupKey;
    // 用户已跳过该版本：静默（顶栏徽标同样不显示）
    if (version !== undefined && version === skippedVersion) {
      return;
    }
    notifyPhase(state, install, t);
  }, [state, fromSnapshot, install, skippedVersion, t]);

  return null;
}
