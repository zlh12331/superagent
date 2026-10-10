import type { ChannelListRes } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorRow, QueryPendingRow } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { IM_CHANNELS_QUERY_KEY } from '@/lib/query/keys';
import {
  type ImChannelKind,
  listImChannels,
  startImChannel,
  stopImChannel,
} from '@/lib/settings-ops';
import { cn } from '@/lib/utils';
import { ImAllowlistField } from './im-allowlist-field';

/** IM 渠道设置区：渠道列表 + token 录入与启停 + 群聊白名单字段 */
export function ImChannelsSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const {
    data: channelsData,
    isPending: channelsLoading,
    isError: channelsFailed,
    error: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: IM_CHANNELS_QUERY_KEY,
    queryFn: listImChannels,
  });
  const channels = channelsData?.channels ?? [];

  /** 启动 mutation：成功后失效渠道列表 */
  const startMutation = useMutation({
    mutationFn: async (kind: ImChannelKind) => {
      const token = (tokenInputs[kind] ?? '').trim();
      await startImChannel({ kind, ...(token !== '' ? { token } : {}) });
    },
    onSuccess: (_data, kind) => {
      toast.success(t('settings.imChannelStarted'));
      setTokenInputs((prev) => ({ ...prev, [kind]: '' }));
      void queryClient.invalidateQueries({ queryKey: IM_CHANNELS_QUERY_KEY });
    },
    onError: () => {
      toast.error(t('settings.imChannelStartFailed'));
    },
  });

  const stopMutation = useMutation({
    mutationFn: (kind: ImChannelKind) => stopImChannel(kind),
    onSuccess: () => {
      toast.success(t('settings.imChannelStopSuccess'));
      void queryClient.invalidateQueries({ queryKey: IM_CHANNELS_QUERY_KEY });
    },
    onError: () => {
      toast.error(t('settings.imChannelStopFailed'));
    },
  });

  const handleStart = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      await startMutation.mutateAsync(kind as ChannelListRes['channels'][number]['kind']);
    } catch {}
    setBusy(null);
  };

  const handleStop = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      await stopMutation.mutateAsync(kind as ChannelListRes['channels'][number]['kind']);
    } catch {}
    setBusy(null);
  };

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.imChannelsSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.imChannelsHint')}</p>

      <QueryErrorRow
        isError={channelsFailed}
        errorMessage={channelsError instanceof Error ? channelsError.message : null}
        onRetry={() => void refetchChannels()}
      />
      <QueryPendingRow isPending={channelsLoading} />

      <ul className="flex flex-col gap-2 text-xs font-sans">
        {channels.map((channel) => (
          <ImChannelRow
            key={channel.kind}
            channel={channel}
            busy={busy === channel.kind}
            token={tokenInputs[channel.kind] ?? ''}
            onTokenChange={(value) =>
              setTokenInputs((prev) => ({ ...prev, [channel.kind]: value }))
            }
            onStart={() => void handleStart(channel.kind)}
            onStop={() => void handleStop(channel.kind)}
          />
        ))}
      </ul>
      <div className="mt-2">
        <ImAllowlistField />
      </div>
    </div>
  );
}

/** 单个渠道行（提取自 ImChannelsSection，保持其函数体在棘轮基线内） */
function ImChannelRow(props: {
  readonly channel: ChannelListRes['channels'][number];
  readonly busy: boolean;
  readonly token: string;
  readonly onTokenChange: (value: string) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { channel, busy, token, onTokenChange, onStart, onStop } = props;
  return (
    <li className="rounded border border-border px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium text-foreground">{channel.displayName}</span>
          <span className="block truncate text-muted-foreground">{channel.description}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-2xs',
              channel.running
                ? 'bg-success/10 text-success-text'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {channel.running ? t('settings.imChannelRunning') : t('settings.imChannelStopped')}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={channel.running ? onStop : onStart}
            disabled={busy || (!channel.running && !channel.implemented)}
          >
            {channel.running ? t('settings.imChannelStop') : t('settings.imChannelStart')}
          </Button>
        </div>
      </div>
      {channel.implemented && !channel.configured && (
        <div className="mt-1.5 flex gap-1.5">
          <Input
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder={t('settings.imChannelTokenPlaceholder')}
            className="h-7 font-mono text-xs"
          />
          <Button variant="outline" size="sm" className="h-7" onClick={onStart} disabled={busy}>
            {t('settings.imChannelSave')}
          </Button>
        </div>
      )}
    </li>
  );
}
