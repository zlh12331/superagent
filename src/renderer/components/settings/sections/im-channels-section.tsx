// im-channels-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ImChannelsSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { ChannelListRes } from '@code-agent/shared/renderer';
import { MessageSquareText } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';

export function ImChannelsSection(): ReactElement {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelListRes['channels'] | null>(null);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadChannels = useCallback(() => {
    window.api.im
      .list()
      .then((res) => {
        setChannels(unwrap<ChannelListRes>(res).channels);
      })
      .catch(() => {
        // 列表加载失败：静默（渠道功能不可用时降级）
      });
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const handleStart = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      const token = tokenInputs[kind];
      await window.api.im.start({
        kind: kind as ChannelListRes['channels'][number]['kind'],
        // zod transform 输出为 string | undefined：显式传 undefined
        token: token !== undefined && token.trim().length > 0 ? token.trim() : undefined,
      });
      toast.success(t('settings.imChannelStarted'));
      setTokenInputs((prev) => ({ ...prev, [kind]: '' }));
      loadChannels();
    } catch {
      toast.error(t('settings.imChannelStartFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async (kind: string): Promise<void> => {
    setBusy(kind);
    try {
      await window.api.im.stop({ kind: kind as ChannelListRes['channels'][number]['kind'] });
      toast.success(t('settings.imChannelStopSuccess'));
      loadChannels();
    } catch {
      toast.error(t('settings.imChannelStopFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (channels === null) {
    return <div className="space-y-2 pt-2" />;
  }

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.imChannelsSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.imChannelsHint')}</p>

      <ul className="space-y-2 text-xs font-sans">
        {channels.map((channel) => (
          <li key={channel.kind} className="rounded border border-stone-100 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="block font-medium text-stone-800">{channel.displayName}</span>
                <span className="block truncate text-muted-foreground">{channel.description}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px]',
                    channel.running
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-stone-100 text-stone-500',
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
