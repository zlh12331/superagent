// src/renderer/hooks/use-approval-mode.ts
// 审批模式 hook：读取/更新 ApprovalMode（settings:getApprovalMode / setApprovalMode）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 渲染层本地状态（设置页单选）；主进程持久化 + PermissionService 同步
// - 切换失败回滚原值（toast 提示）
// ──────────────────────────────────────────────────────────────

import type { ApprovalMode } from '@code-agent/shared/renderer';
import * as Sentry from '@sentry/electron/renderer';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

const DEFAULT_MODE: ApprovalMode = 'ask';

/**
 * 审批模式（默认 ask：保守）
 */
export function useApprovalMode(): {
  mode: ApprovalMode;
  setMode: (mode: ApprovalMode) => Promise<void>;
} {
  const { t } = useTranslation();
  const [mode, setModeState] = useState<ApprovalMode>(DEFAULT_MODE);

  useEffect(() => {
    // 浏览器模式（dev 预览）无 window.api：保持默认模式
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    let cancelled = false;
    window.api.settings
      .getApprovalMode()
      .then((res) => {
        if (!cancelled) {
          setModeState(unwrap<{ mode: ApprovalMode }>(res).mode);
        }
      })
      .catch((error: unknown) => {
        // 读取失败：保持默认 ask（fail-safe 降级，不打扰用户）。
        // 但仍上报 Sentry——否则"读不到审批模式"这类故障在线上零线索
        // （dev/test/web 下 Sentry 未 init，captureException 是空操作）。
        Sentry.captureException(error, { tags: { scope: 'use-approval-mode.read' } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(
    async (next: ApprovalMode): Promise<void> => {
      const previous = mode;
      // 乐观更新：立即回显，失败回滚
      setModeState(next);
      try {
        await window.api.settings.setApprovalMode({ mode: next });
      } catch {
        setModeState(previous);
        toast.error(t('settings.approvalModeSaveFailed'));
      }
    },
    [mode, t],
  );

  return { mode, setMode };
}
