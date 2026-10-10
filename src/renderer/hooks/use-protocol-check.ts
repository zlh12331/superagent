import { IPC_PROTOCOL_VERSION } from '@code-agent/shared/renderer';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { reportError } from '@/lib/error-report';
import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 启动时校验 IPC 协议版本（AppShell 挂载一次）
 *
 * 不匹配场景：自动更新后单侧先更新（主进程旧/新 vs 渲染层新/旧）。
 * 提示用户重启应用；不阻断正常功能（校验失败静默——非关键路径）。
 */
export function useProtocolCheck(): void {
  const { t } = useTranslation();

  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }
    let cancelled = false;
    window.api.app
      .getStatus()
      .then((res) => {
        if (cancelled) return;
        const data = unwrap(res);
        if (data.protocolVersion !== IPC_PROTOCOL_VERSION) {
          toast.warning(t('common.protocolMismatch'), {
            description: `${t('common.protocolMismatchDesc')} (main=${data.protocolVersion} / renderer=${IPC_PROTOCOL_VERSION})`,
            duration: 10_000,
          });
        }
      })
      .catch((error: unknown) => {
        reportError(error, { tags: { scope: 'use-protocol-check' } });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);
}
