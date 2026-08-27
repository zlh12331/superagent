// im-channels-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ImChannelsSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { ChannelListRes } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';

/** IM 渠道列表查询 key */
const IM_CHANNELS_QUERY_KEY = ['im', 'channels'] as const;

export function ImChannelsSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // P3 修复：im:list 改走 TanStack Query（此前 useState 手动拉取）
  const {
    data: channelsData,
    isError: channelsFailed,
    error: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: IM_CHANNELS_QUERY_KEY,
    queryFn: async () => {
      // 浏览器模式（dev 预览）无 window.api：静默空列表
      if (typeof window === 'undefined' || window.api === undefined) {
        return { channels: [] as ChannelListRes['channels'] };
      }
      const res = await window.api.im.list();
      if ('error' in res && res.error !== undefined) {
        // 列表加载失败：静默（渠道功能不可用时降级）
        return { channels: [] as ChannelListRes['channels'] };
      }
      return unwrap<ChannelListRes>(res);
    },
  });
  const channels = channelsData?.channels ?? [];
  // 启动 mutation：成功后失效渠道列表
  const startMutation = useMutation({
    mutationFn: async (kind: ChannelListRes['channels'][number]['kind']) => {
      const token = tokenInputs[kind];
      await window.api.im.start({
        kind,
        // zod transform 输出为 string | undefined：显式传 undefined
        token: token !== undefined && token.trim().length > 0 ? token.trim() : undefined,
      });
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

  // 停止 mutation：成功后失效渠道列表
  const stopMutation = useMutation({
    mutationFn: async (kind: ChannelListRes['channels'][number]['kind']) => {
      await window.api.im.stop({ kind });
    },
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
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      await stopMutation.mutateAsync(kind as ChannelListRes['channels'][number]['kind']);
    } finally {
      setBusy(null);
    }
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

      <ul className="flex flex-col gap-2 text-xs font-sans">
        {channels.map((channel) => (
          <li key={channel.kind} className="rounded border border-border px-2.5 py-2">
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
                  {channel.running
                    ? t('settings.imChannelRunning')
                    : t('settings.imChannelStopped')}
                </span>
                {channel.running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleStop(channel.kind)}
                    disabled={busy === channel.kind}
                  >
                    {t('settings.imChannelStop')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleStart(channel.kind)}
                    disabled={busy === channel.kind || !channel.implemented}
                  >
                    {t('settings.imChannelStart')}
                  </Button>
                )}
              </div>
            </div>
            {/* 未配置 token 的已实现渠道：显示 token 输入（首次启动） */}
            {channel.implemented && !channel.configured && (
              <div className="mt-1.5 flex gap-1.5">
                <Input
                  type="password"
                  value={tokenInputs[channel.kind] ?? ''}
                  onChange={(e) =>
                    setTokenInputs((prev) => ({ ...prev, [channel.kind]: e.target.value }))
                  }
                  placeholder={t('settings.imChannelTokenPlaceholder')}
                  className="h-7 font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => void handleStart(channel.kind)}
                  disabled={busy === channel.kind}
                >
                  {t('settings.imChannelSave')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
