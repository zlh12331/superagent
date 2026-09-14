// src/renderer/hooks/use-approval-mode.ts
// 审批模式 hook：读取/更新 ApprovalMode（settings:getApprovalMode / setApprovalMode）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 渲染层本地状态（设置页单选）；主进程持久化 + PermissionService 同步
// - 切换失败回滚原值（toast 提示）
// ──────────────────────────────────────────────────────────────

import type { ApprovalMode } from '@code-agent/shared/renderer';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { reportError } from '@/lib/error-report';
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
        // 但仍落盘主日志——否则"读不到审批模式"这类故障在报障时零线索。
        reportError(error, { tags: { scope: 'use-approval-mode.read' } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(
    async (next: ApprovalMode): Promise<void> => {
      const previous = mode;
      if (typeof window === 'undefined' || window.api === undefined) {
        // 浏览器模式无语义可写：仅本地回显（与上方读取分支同构）
        setModeState(next);
        return;
      }
      // 乐观更新：立即回显，失败回滚
      setModeState(next);
      try {
        // ⚠️ 必须 unwrap：主进程失败时 wrap 返回 `{ error }` 响应而**不是** reject
        // （src/main/utils/wrap.ts 的 catch 分支），只用 try/catch 接不住失败 →
        // 回滚永不执行、UI 停留在"已切换"的假成功态。
        unwrap(await window.api.settings.setApprovalMode({ mode: next }));
      } catch (error: unknown) {
        setModeState(previous);
        toast.error(t('settings.approvalModeSaveFailed'));
        reportError(error, { tags: { scope: 'use-approval-mode.write' } });
      }
    },
    [mode, t],
  );

  return { mode, setMode };
}
