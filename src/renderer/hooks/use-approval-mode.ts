import type { ApprovalMode } from '@code-agent/shared/renderer';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { reportError } from '@/lib/error-report';
import { hasIpcBridge, unwrap } from '@/lib/ipc';

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
    if (!hasIpcBridge()) {
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
        reportError(error, { tags: { scope: 'use-approval-mode.read' } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = async (next: ApprovalMode): Promise<void> => {
    const previous = mode;
    if (!hasIpcBridge()) {
      setModeState(next);
      return;
    }
    setModeState(next);
    try {
      unwrap(await window.api.settings.setApprovalMode({ mode: next }));
    } catch (error: unknown) {
      setModeState(previous);
      toast.error(t('settings.approvalModeSaveFailed'));
      reportError(error, { tags: { scope: 'use-approval-mode.write' } });
    }
  };

  return { mode, setMode };
}
