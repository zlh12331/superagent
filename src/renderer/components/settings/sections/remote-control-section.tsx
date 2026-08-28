// src/renderer/components/settings/sections/remote-control-section.tsx
// 设置 · 远程控制面板（局域网移动端配对入口）
// ──────────────────────────────────────────────────────────────
// 阶段 2.5 落地：主进程 RemoteControlService（HTTP 桥接 + UDP 发现）与
// RemoteAgentBridge（无头执行）已就绪，本面板提供启停开关与配对凭据展示。
// 安全基线：令牌仅在运行期由 remote:getStatus 快照下发（停止后主进程置 null），
// 面板不持久化令牌；关闭服务即撤销全部局域网入口。
// ──────────────────────────────────────────────────────────────

import type { RemoteStatusRes } from '@code-agent/shared/renderer';
import { Copy, Loader2, ShieldAlert, Smartphone } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { QueryErrorRow } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import {
  useRemoteStatusQuery,
  useStartRemoteControl,
  useStopRemoteControl,
} from '@/hooks/use-remote-control';
import { useTranslation } from '@/i18n/use-translation';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { SettingRow, ToggleRow } from '../settings-controls';

/** 配对信息卡：令牌 + 局域网端点（令牌为 null 时不渲染） */
function PairingCard({
  status,
  onCopyToken,
}: {
  readonly status: RemoteStatusRes;
  readonly onCopyToken: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (status.token === null) {
    return null;
  }
  return (
    <div className="bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground text-sm">{t('settings.remote.tokenLabel')}</span>
        <Button variant="outline" size="sm" className="h-7" onClick={onCopyToken}>
          <Copy className="size-3.5" strokeWidth={1.5} />
          {t('settings.remote.copyToken')}
        </Button>
      </div>
      <p className="text-foreground font-mono text-xs break-all">{status.token}</p>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-2xs">
          {t('settings.remote.endpointsLabel')}
        </span>
        {status.addresses.length === 0 ? (
          <span className="text-muted-foreground text-2xs">{t('settings.remote.noEndpoint')}</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {status.addresses.map((endpoint) => (
              <li key={endpoint} className="text-foreground font-mono text-2xs break-all">
                {endpoint}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 无头执行审批模式提示：非 auto/yolo 时远程命令会被桥接拒绝 */
function HeadlessModeWarning({ mode }: { readonly mode: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="text-warning bg-warning/10 border-warning/30 flex items-start gap-2 rounded-lg border px-3 py-2">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
      <span className="text-2xs leading-relaxed">{t('settings.remote.modeWarning', { mode })}</span>
    </div>
  );
}

export function RemoteControlSection(): ReactElement {
  const { t } = useTranslation();
  const { data, isError, error, refetch } = useRemoteStatusQuery();
  const { mode } = useApprovalMode();
  const startMutation = useStartRemoteControl();
  const stopMutation = useStopRemoteControl();

  const running = data?.running === true;
  const pending = startMutation.isPending || stopMutation.isPending;

  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      if (checked) {
        await startMutation.mutateAsync();
        toast.success(t('settings.remote.started'));
      } else {
        await stopMutation.mutateAsync();
        toast.success(t('settings.remote.stopped'));
      }
    } catch {
      toast.error(t('settings.remote.toggleFailed'));
    }
  };

  const handleCopyToken = async (): Promise<void> => {
    if (data?.token === undefined || data.token === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(data.token);
      toast.success(t('settings.remote.tokenCopied'));
    } catch {
      toast.error(t('settings.remote.tokenCopyFailed'));
    }
  };

  const toggleDescription = !running
    ? t('settings.remote.stoppedDescription')
    : data === undefined || data.port === null
      ? t('settings.remote.startingDescription')
      : t('settings.remote.portDescription', { name: data.instanceName, port: data.port });

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <Smartphone className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="text-foreground font-serif text-sm tracking-wide">
          {t('settings.remote.section')}
        </span>
        {data !== undefined && (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-2xs',
              running ? 'bg-success/10 text-success-text' : 'bg-muted text-muted-foreground',
            )}
          >
            {running ? t('settings.remote.running') : t('settings.remote.idle')}
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-xs font-sans">{t('settings.remote.hint')}</p>

      <QueryErrorRow
        isError={isError}
        errorMessage={error instanceof Error ? error.message : null}
        onRetry={() => void refetch()}
      />

      <ToggleRow
        name={t('settings.remote.toggle')}
        description={toggleDescription}
        checked={running}
        onChange={(checked) => void handleToggle(checked)}
      />

      {pending && (
        <span className="text-muted-foreground flex items-center gap-1.5 text-2xs">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          {t('settings.remote.applying')}
        </span>
      )}

      {running && data !== undefined && (
        <PairingCard status={data} onCopyToken={() => void handleCopyToken()} />
      )}
      {running && mode !== 'auto' && mode !== 'yolo' && <HeadlessModeWarning mode={mode} />}
      {running && data !== undefined && (
        <SettingRow
          label={t('settings.remote.activity')}
          description={
            data.lastCommandAt === null
              ? t('settings.remote.noCommandYet')
              : formatRelativeTime(data.lastCommandAt, t)
          }
          className="py-2"
        >
          <span className="text-foreground font-mono text-xs">
            {t('settings.remote.activeCommands', { count: data.activeCommands })}
          </span>
        </SettingRow>
      )}
    </div>
  );
}
