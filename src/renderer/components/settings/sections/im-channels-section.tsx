// im-channels-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ImChannelsSection 独立面板（高内聚）
// ──────────────────────────────────────────────

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
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { IM_CHANNELS_QUERY_KEY } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { ImAllowlistField } from './im-allowlist-field';

export function ImChannelsSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // P3 修复：im:list 改走 TanStack Query（此前 useState 手动拉取）
  const {
    data: channelsData,
    isPending: channelsLoading,
    isError: channelsFailed,
    error: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: IM_CHANNELS_QUERY_KEY,
    queryFn: async () => {
      // 浏览器模式（dev 预览）无 window.api：空列表（面板可渲染，只是无渠道）
      if (!hasIpcBridge()) {
        return { channels: [] as ChannelListRes['channels'] };
      }
      // 不在此吞异常（2026-09 审计修复）：此前 catch 后 return []，使
      // `channelsFailed` 恒为 false → 下方 QueryErrorRow + onRetry 是**不可达死代码**，
      // 且真实的 IPC 故障与「一个渠道都没配」在 UI 上完全一样（用户无从判断）。
      // 抛给 TanStack 后由 QueryErrorRow 统一呈现错误与重试（与 mcp/skills/turns 一致）。
      return unwrap<ChannelListRes>(await window.api.im.list());
    },
  });
  const channels = channelsData?.channels ?? [];

  // 启动/停止渠道的状态类型别名（此前内联写法在本文件重复 8 次）
  type ImChannelKind = ChannelListRes['channels'][number]['kind'];
  /** 启动 mutation：成功后失效渠道列表 */
  const startMutation = useMutation({
    mutationFn: async (kind: ImChannelKind) => {
      // 浏览器模式（dev 预览）无桥：抛可读错误交给 onError 提示
      if (!hasIpcBridge()) throw new Error('window.api unavailable');
      const token = (tokenInputs[kind] ?? '').trim();
      unwrap(await window.api.im.start({ kind, token: token !== '' ? token : undefined }));
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
    mutationFn: async (kind: ImChannelKind) => {
      if (!hasIpcBridge()) throw new Error('window.api unavailable');
      unwrap(await window.api.im.stop({ kind }));
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
    } catch {
      // 启动失败：onError 已 toast，这里补 catch 防未处理的 rejection 冒泡
    }
    // finally 语义（React Compiler 不优化 try/finally）：catch 吞掉全部异常，
    // 成功/失败路径都落到这里复位忙碌状态
    setBusy(null);
  };

  const handleStop = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      await stopMutation.mutateAsync(kind as ChannelListRes['channels'][number]['kind']);
    } catch {
      // 停止失败：onError 已 toast，这里补 catch 防未处理的 rejection 冒泡
    }
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
        {/* 群聊白名单：私聊默认放行，群聊需登记 */}
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
      {/* 未配置 token 的已实现渠道：显示 token 输入（首次启动） */}
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
