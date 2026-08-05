// src/renderer/components/settings/SettingsDialog.tsx
// 设置对话框 · API Key 管理 + 系统提示词管理
// ──────────────────────────────────────────────────────────────
// 职责：
// - 受控 Dialog：由父组件通过 open / onOpenChange 控制开关
// - 内嵌 DeepSeek API Key 输入 / 保存 / 删除 / 状态展示
// - 内嵌 Code Agent 系统提示词编辑（覆盖默认 system prompt）
// - 通过 TanStack Query 管理 IPC 请求状态，自动失效缓存
//
// 设计：
// - 极简文学风：衬线字体标题、米色纸张背景、墨色文字点缀
// - 安全：API Key 输入框默认隐藏，点击眼睛图标切换显隐
// - 反馈：保存 / 删除成功后 toast 提示
// ──────────────────────────────────────────────────────────────

import type {
  ApiKeyProvider,
  ChannelListRes,
  ListRuntimeModelsRes,
  SessionRecentTurnsRes,
  TelemetryLevel,
  TurnStatusText,
  UsageSummaryRes,
} from '@code-agent/shared/renderer';
import {
  BarChart3,
  Database,
  Eye,
  EyeOff,
  History,
  Keyboard,
  KeyRound,
  Loader2,
  MessageSquareText,
  Plus,
  Shield,
  Trash2,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { useSetTelemetryLevel, useTelemetryLevelQuery } from '@/hooks/use-telemetry';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/**
 * 审批模式区块：工具调用审批策略（plan / ask / auto / yolo）
 *
 * 数据来源：settings:getApprovalMode / setApprovalMode（持久化 approval-pref.json）。
 */
function ApprovalModeSection(): ReactElement {
  const { t } = useTranslation();
  const { mode, setMode } = useApprovalMode();

  const options = [
    {
      value: 'plan' as const,
      label: t('settings.approvalModePlan'),
      desc: t('settings.approvalModePlanDesc'),
    },
    {
      value: 'ask' as const,
      label: t('settings.approvalModeAsk'),
      desc: t('settings.approvalModeAskDesc'),
    },
    {
      value: 'auto' as const,
      label: t('settings.approvalModeAuto'),
      desc: t('settings.approvalModeAutoDesc'),
    },
    {
      value: 'yolo' as const,
      label: t('settings.approvalModeYolo'),
      desc: t('settings.approvalModeYoloDesc'),
    },
  ];

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <Shield className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.approvalModeSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.approvalModeHint')}</p>
      <div className="grid gap-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded border px-2.5 py-1.5',
              mode === option.value
                ? 'border-stone-400 bg-stone-50'
                : 'border-stone-100 hover:border-stone-300',
            )}
          >
            <input
              type="radio"
              name="approval-mode"
              checked={mode === option.value}
              onChange={() => void setMode(option.value)}
              className="mt-0.5 size-3.5 accent-stone-700"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-stone-800 font-sans">
                {option.label}
              </span>
              <span className="block text-xs text-muted-foreground font-sans">{option.desc}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * 用量统计区块：展示全部会话的 token 消耗汇总（总量 / 按模型 / 按日）
 *
 * 数据来源：session:getUsageSummary（token_usage 表聚合）。
 */
function UsageSection(): ReactElement {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummaryRes | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.session
      .getUsageSummary()
      .then((res) => {
        if (!cancelled) {
          setSummary(unwrap<UsageSummaryRes>(res));
        }
      })
      .catch(() => {
        toast.error(t('settings.usageLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const isEmpty = summary === null || summary.total.calls === 0;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.usageSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.usageHint')}</p>

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.usageEmpty')}</p>
      ) : (
        <div className="space-y-2 font-sans">
          {/* 总量 */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageTotalCalls')}</p>
              <p className="mt-0.5 font-medium text-stone-800">{summary.total.calls}</p>
            </div>
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageTotalTokens')}</p>
              <p className="mt-0.5 font-medium text-stone-800">{summary.total.totalTokens}</p>
            </div>
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageCacheHit')}</p>
              <p className="mt-0.5 font-medium text-stone-800">
                {summary.byModel.reduce((sum, m) => sum + m.cacheReadTokens, 0)}
              </p>
            </div>
          </div>

          {/* 按模型 */}
          <div>
            <p className="text-xs font-medium text-stone-600">{t('settings.usageByModel')}</p>
            <ul className="mt-1 space-y-1 text-xs">
              {summary.byModel.map((m) => (
                <li
                  key={m.modelId}
                  className="flex items-center justify-between rounded border border-stone-100 px-2 py-1"
                >
                  <span className="truncate text-stone-700">{m.modelId}</span>
                  <span className="ml-2 shrink-0 text-muted-foreground">
                    {m.calls} 次 · {m.totalTokens} tokens
                    {m.reasoningTokens > 0
                      ? ` · ${t('settings.usageReasoning')} ${m.reasoningTokens}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 按日 */}
          <div>
            <p className="text-xs font-medium text-stone-600">{t('settings.usageByDay')}</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {summary.byDay.map((d) => (
                <li key={d.date} className="flex items-center justify-between text-stone-600">
                  <span>{d.date}</span>
                  <span className="text-muted-foreground">
                    {d.calls} 次 · {d.totalTokens} tokens
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 回合记录区块：展示最近 Agent 回合的终止原因与 token 消耗（Transcript）
 *
 * 数据来源：session:getRecentTurns（turns 表跨会话倒序查询）。
 */
function TurnsSection(): ReactElement {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<SessionRecentTurnsRes['turns'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.session
      .getRecentTurns({ limit: 10 })
      .then((res) => {
        if (!cancelled) {
          setTurns(unwrap<SessionRecentTurnsRes>(res).turns);
        }
      })
      .catch(() => {
        toast.error(t('settings.turnsLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const isEmpty = turns === null || turns.length === 0;
  const statusKey: TurnStatusText = {
    completed: t('settings.turnStatusCompleted'),
    aborted: t('settings.turnStatusAborted'),
    'max-steps': t('settings.turnStatusMaxSteps'),
    error: t('settings.turnStatusError'),
  };

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <History className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.turnsSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.turnsHint')}</p>

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.turnsEmpty')}</p>
      ) : (
        <ul className="space-y-1 text-xs font-sans">
          {turns.map((turn) => (
            <li
              key={turn.turnId}
              className="flex items-center justify-between gap-2 rounded border border-stone-100 px-2 py-1"
            >
              <span className="truncate text-stone-700">
                {turn.modelId}
                <span className="ml-1 text-muted-foreground">#{turn.seq}</span>
              </span>
              <span className="ml-2 shrink-0 text-muted-foreground">
                {statusKey[turn.status] ?? turn.status}
                {turn.totalTokens !== undefined ? ` · ${turn.totalTokens} tokens` : ''}
                {turn.durationMs !== undefined ? ` · ${Math.round(turn.durationMs / 1000)}s` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 自定义模型区块：添加/删除运行时模型（持久化 + 注册 + 缓存失效）
 *
 * 数据来源：settings:listRuntimeModels / addRuntimeModel / removeRuntimeModel。
 */
function RuntimeModelsSection(): ReactElement {
  const { t } = useTranslation();
  const [models, setModels] = useState<ListRuntimeModelsRes['models'] | null>(null);
  const [modelId, setModelId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [adding, setAdding] = useState(false);

  const loadModels = useCallback(() => {
    window.api.settings
      .listRuntimeModels()
      .then((res) => {
        setModels(unwrap<ListRuntimeModelsRes>(res).models);
      })
      .catch(() => {
        toast.error(t('settings.runtimeModelLoadFailed'));
      });
  }, [t]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleAdd = async (): Promise<void> => {
    if (modelId.trim().length === 0) {
      return;
    }
    setAdding(true);
    try {
      await window.api.settings.addRuntimeModel({
        modelId: modelId.trim(),
        providerKind: 'openai',
        // zod transform 输出为 string | undefined：显式传 undefined
        baseUrl: baseUrl.trim().length > 0 ? baseUrl.trim() : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      });
      toast.success(t('settings.runtimeModelAdded'));
      setModelId('');
      setBaseUrl('');
      setApiKey('');
      loadModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await window.api.settings.removeRuntimeModel({ modelId: id });
      toast.success(t('settings.runtimeModelRemoved'));
      loadModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    }
  };

  const isEmpty = models === null || models.length === 0;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <Plus className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.runtimeModelsSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.runtimeModelsHint')}</p>

      {/* 添加表单 */}
      <div className="space-y-1.5">
        <Input
          type="text"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={t('settings.runtimeModelIdPlaceholder')}
          className="font-mono text-xs"
        />
        <Input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t('settings.runtimeModelBaseUrlPlaceholder')}
          className="font-mono text-xs"
        />
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('settings.runtimeModelApiKeyPlaceholder')}
          className="font-mono text-xs"
        />
        <Button variant="outline" size="sm" onClick={handleAdd} disabled={adding}>
          {adding ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Plus className="size-3.5" strokeWidth={1.5} />
          )}
          {t('settings.runtimeModelAdd')}
        </Button>
      </div>

      {/* 模型列表 */}
      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">
          {t('settings.runtimeModelsEmpty')}
        </p>
      ) : (
        <ul className="space-y-1 text-xs font-sans">
          {models.map((m) => (
            <li
              key={m.modelId}
              className="flex items-center justify-between gap-2 rounded border border-stone-100 px-2 py-1"
            >
              <span className="truncate text-stone-700">
                {m.modelId}
                <span className="ml-1 text-muted-foreground">({m.providerKind})</span>
              </span>
              <button
                type="button"
                onClick={() => void handleRemove(m.modelId)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('settings.runtimeModelRemove')}
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * IM 渠道区块：渠道列表 / 启停 / token 配置
 *
 * 数据来源：im:list / start / stop（token 存 keychain，不落库）。
 */
function ImChannelsSection(): ReactElement {
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

interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 切换打开状态 */
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * 掩码显示已设置的 API Key
 *
 * 只展示前 4 位与后 4 位，中间用 ··· 连接。
 * 既让用户能确认 Key 已设置，又不暴露完整明文。
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '·'.repeat(key.length);
  return `${key.slice(0, 4)}${'·'.repeat(Math.min(12, key.length - 8))}${key.slice(-4)}`;
}

/**
 * 设置对话框组件
 *
 * 当前仅包含 DeepSeek API Key 管理面板，后续可扩展更多设置项。
 *
 * @example
 * ```tsx
 * const [open, setOpen] = useState(false);
 * return (
 *   <>
 *     <Button onClick={() => setOpen(true)}>设置</Button>
 *     <SettingsDialog open={open} onOpenChange={setOpen} />
 *   </>
 * );
 * ```
 */

interface ApiKeySectionProps {
  readonly provider: ApiKeyProvider;
  readonly label: string;
}

function ApiKeySection({ provider, label }: ApiKeySectionProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const { data: apiKey, isLoading } = useApiKeyQuery(provider);
  const { mutate: setApiKey, isPending: isSaving } = useSetApiKey();
  const { mutate: deleteApiKey, isPending: isDeleting } = useDeleteApiKey();

  const [inputValue, setInputValue] = useState('');
  const [showPlain, setShowPlain] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setInputValue('');
    setShowPlain(false);
    setEditing(false);
  }, []);

  const isConfigured = apiKey !== null && apiKey !== undefined && apiKey !== '';

  const handleSave = (): void => {
    if (inputValue.trim() === '') {
      toast.error(t('settings.apiKeyEmpty'));
      return;
    }
    setApiKey(
      { provider, apiKey: inputValue.trim() },
      {
        onSuccess: () => {
          toast.success(t('settings.apiKeySaved', { label }));
          setInputValue('');
          setEditing(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(provider, {
      onSuccess: () => {
        toast.success(t('settings.apiKeyDeleted', { label }));
        setInputValue('');
        setEditing(false);
      },
    });
  };

  return (
    <div className="space-y-3 py-2">
      <Label htmlFor={`${provider}-api-key`} className="font-serif text-sm tracking-wide">
        {label} API Key
      </Label>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
          <span className="text-sm">{t('common.loading')}</span>
        </div>
      ) : isConfigured && !editing ? (
        <div className="space-y-2">
          <div className="bg-muted/40 flex items-center justify-between rounded-md border px-3 py-2 font-mono text-sm">
            <span className="truncate">{maskApiKey(apiKey ?? '')}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
              onClick={() => setShowPlain((v) => !v)}
            >
              {showPlain ? (
                <EyeOff className="size-3.5" strokeWidth={1.5} />
              ) : (
                <Eye className="size-3.5" strokeWidth={1.5} />
              )}
            </Button>
          </div>
          {showPlain && (
            <div className="bg-muted/30 break-all rounded-md border px-3 py-2 font-mono text-xs">
              {apiKey}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setInputValue('');
              }}
            >
              {t('settings.modify')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Trash2 className="size-3.5" strokeWidth={1.5} />
              )}
              {t('common.delete')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            id={`${provider}-api-key`}
            type={showPlain ? 'text' : 'password'}
            placeholder="sk-..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            autoFocus
            className="font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSaving || inputValue.trim() === ''}>
              {isSaving ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
              {t('common.save')}
            </Button>
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setInputValue('');
                }}
              >
                取消
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
              onClick={() => setShowPlain((v) => !v)}
            >
              {showPlain ? (
                <EyeOff className="size-3.5" strokeWidth={1.5} />
              ) : (
                <Eye className="size-3.5" strokeWidth={1.5} />
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const persistedSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);
  const updateAi = useSettingsStore((s) => s.updateAi);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const updateShortcuts = useSettingsStore((s) => s.updateShortcuts);

  const { data: telemetryLevel, isLoading: isLoadingTelemetry } = useTelemetryLevelQuery();
  const { mutate: setTelemetryLevel, isPending: isSavingTelemetry } = useSetTelemetryLevel();

  const [promptDraft, setPromptDraft] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);

  useEffect(() => {
    if (open) {
      setPromptDraft('');
      setPromptEditing(false);
    }
  }, [open]);

  // 系统提示词：进入编辑时，加载当前持久化值到 draft
  const handlePromptEdit = (): void => {
    setPromptDraft(persistedSystemPrompt);
    setPromptEditing(true);
  };

  // 系统提示词：保存到 settings store
  const handlePromptSave = (): void => {
    updateAi({ systemPrompt: promptDraft });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success(t('settings.promptSaved'));
  };

  // 系统提示词：清空（恢复使用默认 system prompt）
  const handlePromptClear = (): void => {
    updateAi({ systemPrompt: '' });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success(t('settings.promptReset'));
  };

  // 数据区块：导出全部会话（dialog 选路径，main 写文件）
  const handleExportAll = async (): Promise<void> => {
    try {
      const response = await window.api.session.exportAll();
      const res = unwrap<{ saved: boolean; path?: string }>(response);
      if (res.saved) {
        toast.success(t('settings.exportSuccess', { path: res.path ?? '' }));
      }
      // 用户取消：静默
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  // 数据区块：打开数据目录（会话/备份/日志所在）
  const handleOpenDataDir = async (): Promise<void> => {
    const response = await window.api.app.openDataDir();
    const res = unwrap<{ ok: boolean }>(response);
    if (res.ok) {
      toast.success(t('settings.dataDirOpened'));
    } else {
      toast.error(t('settings.exportFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif tracking-wide">
            <KeyRound className="size-4" strokeWidth={1.5} />
            <span>{t('settings.title')}</span>
          </DialogTitle>
          <DialogDescription className="font-serif">{t('settings.desc')}</DialogDescription>
        </DialogHeader>

        <ApiKeySection provider="deepseek" label="DeepSeek" />
        <div className="border-t border-stone-200/60" />
        <ApiKeySection provider="openai" label="OpenAI" />

        {/* 系统提示词区块（Code Agent 专用） */}
        <div className="space-y-3 border-t border-stone-200/60 pt-4">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label htmlFor="system-prompt" className="font-serif text-sm tracking-wide">
              {t('settings.systemPrompt')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">
            {t('settings.systemPromptHint')}
          </p>

          {promptEditing ? (
            <div className="space-y-2">
              <Textarea
                id="system-prompt"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                placeholder={t('settings.systemPromptPlaceholder')}
                rows={6}
                className="font-mono text-xs"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handlePromptSave}>
                  {t('common.save')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPromptEditing(false);
                    setPromptDraft('');
                  }}
                >
                  {t('common.cancel')}
                </Button>
                {promptDraft.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePromptClear}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    {t('settings.clear')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                {persistedSystemPrompt.length > 0 ? (
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-stone-700">
                    {persistedSystemPrompt}
                  </pre>
                ) : (
                  <span className="text-xs italic text-muted-foreground">
                    {t('settings.useDefaultPrompt')}
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handlePromptEdit}>
                {persistedSystemPrompt.length > 0 ? t('settings.modify') : t('settings.set')}
              </Button>
            </div>
          )}
        </div>

        {/* 遥测级别区块（隐私合规，对标 VS Code telemetryLevel） */}
        <div className="space-y-3 border-t border-stone-200/60 pt-4">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label className="font-serif text-sm tracking-wide">{t('settings.telemetry')}</Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">{t('settings.telemetryHint')}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { value: 'off', label: t('settings.telOff'), desc: t('settings.telOffDesc') },
                {
                  value: 'error-only',
                  label: t('settings.telErrorOnly'),
                  desc: t('settings.telErrorOnlyDesc'),
                },
                { value: 'full', label: t('settings.telFull'), desc: t('settings.telFullDesc') },
              ] as const
            ).map((option) => {
              const isActive = telemetryLevel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={isSavingTelemetry || isLoadingTelemetry}
                  onClick={() => setTelemetryLevel(option.value as TelemetryLevel)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 text-center transition-colors',
                    isActive
                      ? 'border-stone-400 bg-stone-100/60 text-stone-800'
                      : 'border-stone-200 bg-transparent text-stone-500 hover:bg-stone-50',
                  )}
                >
                  <span className="font-serif text-xs tracking-wide">{option.label}</span>
                  <span className="text-[9px] text-muted-foreground">{option.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 快捷键设置区块（Separator 分隔：Radix 原生分隔线替代 border-t） */}
        <Separator className="my-2" />
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <Keyboard className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label className="font-serif text-sm tracking-wide">{t('common.shortcuts')}</Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">{t('common.shortcutsHint')}</p>
          <div className="space-y-2">
            {[
              { key: 'commandPalette', labelKey: 'palette.commandPaletteShortcut' },
              { key: 'saveFile', labelKey: 'common.saveFileShortcut' },
              { key: 'searchFile', labelKey: 'common.searchFileShortcut' },
              { key: 'toggleTheme', labelKey: 'common.toggleThemeShortcut' },
              { key: 'openSettings', labelKey: 'common.openSettingsShortcut' },
              { key: 'newSession', labelKey: 'common.newSessionShortcut' },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-2">
                <span className="text-xs text-stone-600">{t(item.labelKey)}</span>
                <Input
                  type="text"
                  value={shortcuts[item.key as keyof typeof shortcuts]}
                  onChange={(e) =>
                    updateShortcuts({ [item.key]: e.target.value } as Partial<typeof shortcuts>)
                  }
                  className="w-32 font-mono text-xs"
                />
              </div>
            ))}
          </div>
        </div>

        {/* 用量统计区块（token 消耗汇总） */}
        <Separator className="my-2" />
        <UsageSection />

        {/* 审批模式区块（ApprovalMode 配置化） */}
        <Separator className="my-2" />
        <ApprovalModeSection />

        {/* 回合记录区块（Transcript） */}
        <Separator className="my-2" />
        <TurnsSection />

        {/* 自定义模型区块（运行时快照） */}
        <Separator className="my-2" />
        <RuntimeModelsSection />

        {/* IM 渠道区块（Telegram 等渠道集成） */}
        <Separator className="my-2" />
        <ImChannelsSection />

        {/* 数据区块（可靠性/数据极致）：会话导出 + 打开数据目录 */}
        <Separator className="my-2" />
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label className="font-serif text-sm tracking-wide">{t('settings.dataSection')}</Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">{t('settings.dataHint')}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExportAll}>
              {t('settings.exportSessions')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpenDataDir}>
              {t('settings.openDataDir')}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
