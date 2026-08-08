// src/renderer/components/settings/sections/models-section.tsx
// 模型服务 pane（对齐同类桌面 LLM 客户端：统一的提供商/模型管理）
// ──────────────────────────────────────────────────────────────
// 合并原「API 密钥」+「运行时模型」两个 pane：
// - 提供商列表行：内置 4 家，每行显示配置状态徽标（已配置/未配置），
//   点击行展开 API Key 编辑（显示/隐藏/保存/删除）
// - 运行时模型：models:list 拉取真实清单（isRuntime），
//   添加表单（modelId/providerKind/baseUrl）+ 删除
// - 数据源：keychain（API Key 加密存储）+ SQLite（运行时模型持久化）
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';
import { Check, Eye, EyeOff, Loader2, Plus, Radio, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { ApprovalModeSection } from './approval-mode-section';
import { ModelParamsSection } from './model-params-section';

/** 内置提供商列表（显示名 + 供应商枚举） */
const BUILTIN_PROVIDERS: readonly { readonly kind: ApiKeyProvider; readonly label: string }[] = [
  { kind: 'deepseek', label: 'DeepSeek' },
  { kind: 'openai', label: 'OpenAI' },
  { kind: 'anthropic', label: 'Anthropic' },
  { kind: 'ollama', label: 'Ollama' },
];

/**
 * 模型服务 pane
 *
 * 提供商列表 + 运行时模型管理 + 模型参数 + 审批权限（导航收敛后并入）。
 */
export function ModelsSection(): ReactElement {
  const { t } = useTranslation();

  // 运行时模型（models:list 真实清单，isRuntime 过滤）
  const [runtimeModels, setRuntimeModels] = useState<readonly { id: string; label: string }[]>([]);
  // 添加表单
  const [newModelId, setNewModelId] = useState('');
  const [newProvider, setNewProvider] = useState<ApiKeyProvider>('deepseek');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [adding, setAdding] = useState(false);
  // 删除中标记
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadRuntimeModels = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) {
      setRuntimeModels([]);
      return;
    }
    try {
      const res = await window.api.models.list();
      if ('data' in res && res.data !== undefined) {
        setRuntimeModels(
          res.data.models.filter((m) => m.isRuntime).map((m) => ({ id: m.id, label: m.label })),
        );
      }
    } catch {
      setRuntimeModels([]);
    }
  };

  // 仅挂载时加载一次（loadRuntimeModels 每次渲染重建，勿入依赖）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时加载一次
  useEffect(() => {
    void loadRuntimeModels();
  }, []);

  const handleAddRuntime = async (): Promise<void> => {
    if (newModelId.trim() === '') {
      toast.error(t('settings.runtimeModelIdEmpty'));
      return;
    }
    setAdding(true);
    try {
      await window.api.settings.addRuntimeModel({
        modelId: newModelId.trim(),
        providerKind: newProvider,
        // apiKey/baseUrl 经 zod optional+transform 推断为必填属性（值可为 undefined）
        apiKey: undefined,
        baseUrl: newBaseUrl.trim() !== '' ? newBaseUrl.trim() : undefined,
      });
      toast.success(t('settings.runtimeModelAdded'));
      setNewModelId('');
      setNewBaseUrl('');
      await loadRuntimeModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveRuntime = async (id: string): Promise<void> => {
    setRemovingId(id);
    try {
      await window.api.settings.removeRuntimeModel({ modelId: id });
      toast.success(t('settings.runtimeModelRemoved'));
      await loadRuntimeModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      {/* 提供商列表（内置，配置状态可视） */}
      <div>
        <Label className="font-serif text-sm tracking-wide">{t('settings.providersTitle')}</Label>
        <p className="text-muted-foreground mt-0.5 text-xs">{t('settings.providersHint')}</p>
        <div className="mt-2 space-y-1.5">
          {BUILTIN_PROVIDERS.map((p) => (
            <ProviderRow key={p.kind} kind={p.kind} label={p.label} />
          ))}
        </div>
      </div>

      {/* 运行时模型（用户自定义，SQLite 持久化） */}
      <div className="border-border rounded-md border p-3">
        <div className="flex items-center gap-2">
          <Radio className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <Label className="font-serif text-sm tracking-wide">
            {t('settings.runtimeModelsTitle')}
          </Label>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{t('settings.runtimeModelsHint')}</p>

        {/* 已添加列表 */}
        {runtimeModels.length > 0 && (
          <ul className="mt-2 space-y-1">
            {runtimeModels.map((m) => (
              <li
                key={m.id}
                className="border-border bg-muted/30 flex items-center gap-2 rounded border px-2 py-1.5"
              >
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                  {m.id}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-red-500 flex shrink-0 cursor-pointer items-center gap-1 rounded border px-1.5 py-1 text-2xs transition-colors"
                  aria-label={t('settings.removeRuntimeModel')}
                  disabled={removingId === m.id}
                  onClick={() => void handleRemoveRuntime(m.id)}
                >
                  {removingId === m.id ? (
                    <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <Trash2 className="size-3" strokeWidth={1.5} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 添加表单 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Input
            type="text"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder={t('settings.runtimeModelIdPlaceholder')}
            className="min-w-0 flex-1 text-xs"
          />
          <select
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value as ApiKeyProvider)}
            className="border-border bg-background h-8 rounded-md border px-2 text-xs"
            aria-label={t('settings.runtimeModelProvider')}
          >
            {BUILTIN_PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
          <Input
            type="text"
            value={newBaseUrl}
            onChange={(e) => setNewBaseUrl(e.target.value)}
            placeholder={t('settings.runtimeModelBaseUrl')}
            className="min-w-0 w-40 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={adding}
            onClick={() => void handleAddRuntime()}
            className="h-8 gap-1 px-2 text-xs"
          >
            {adding ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            ) : (
              <Plus className="size-3" strokeWidth={1.5} />
            )}
            {t('settings.runtimeModelAdd')}
          </Button>
        </div>
      </div>

      {/* 模型参数（默认模型/温度/思考强度，导航收敛后并入） */}
      <div>
        <ModelParamsSection />
      </div>

      {/* 审批权限（审批模式/白名单，导航收敛后并入） */}
      <div>
        <ApprovalModeSection />
      </div>
    </div>
  );
}

/** 单提供商行：状态徽标 + 展开编辑 API Key */
function ProviderRow({
  kind,
  label,
}: {
  readonly kind: ApiKeyProvider;
  readonly label: string;
}): ReactElement {
  const { t } = useTranslation();
  const { data: apiKey, isLoading } = useApiKeyQuery(kind);
  const { mutate: setApiKey, isPending: isSaving } = useSetApiKey();
  const { mutate: deleteApiKey, isPending: isDeleting } = useDeleteApiKey();

  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showPlain, setShowPlain] = useState(false);

  const isConfigured = apiKey !== null && apiKey !== undefined && apiKey !== '';

  const handleSave = (): void => {
    if (inputValue.trim() === '') {
      toast.error(t('settings.apiKeyEmpty'));
      return;
    }
    setApiKey(
      { provider: kind, apiKey: inputValue.trim() },
      {
        onSuccess: () => {
          toast.success(t('settings.apiKeySaved', { label }));
          setInputValue('');
          setExpanded(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(kind, {
      onSuccess: () => {
        toast.success(t('settings.apiKeyDeleted', { label }));
        setExpanded(false);
      },
    });
  };

  return (
    <div className="border-border bg-muted/20 overflow-hidden rounded-md border">
      {/* 行头：名称 + 状态 + 操作（点击整行展开编辑） */}
      <button
        type="button"
        className="hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="bg-accent/10 text-accent flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold">
          {label[0]}
        </span>
        <span className="text-foreground flex-1 text-sm">{label}</span>
        {isLoading ? (
          <span className="text-muted-foreground text-2xs">…</span>
        ) : isConfigured ? (
          <span className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]">
            <Check className="size-2.5" strokeWidth={2} />
            {t('settings.providerConfigured')}
          </span>
        ) : (
          <span className="text-muted-foreground rounded-full border px-2 py-0.5 font-mono text-[10px]">
            {t('settings.providerNotConfigured')}
          </span>
        )}
        <span className="text-muted-foreground text-2xs">{expanded ? '▾' : '▸'}</span>
      </button>

      {/* 展开编辑区 */}
      {expanded && (
        <div className="border-border border-t px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Input
              type={showPlain ? 'text' : 'password'}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                isConfigured
                  ? t('settings.apiKeyReplacePlaceholder')
                  : t('settings.apiKeyPlaceholder')
              }
              className="min-w-0 flex-1 text-xs"
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors"
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
              onClick={() => setShowPlain((prev) => !prev)}
            >
              {showPlain ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <Button
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={handleSave}
              className="h-7 gap-1 px-2 text-xs"
            >
              {isSaving && <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />}
              {t('settings.saveApiKey')}
            </Button>
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isDeleting}
                onClick={handleDelete}
                className="text-muted-foreground hover:text-red-500 h-7 gap-1 px-2 text-xs"
              >
                <Trash2 className="size-3" strokeWidth={1.5} />
                {t('settings.deleteApiKey')}
              </Button>
            )}
          </div>
          <p className={cn('text-muted-foreground mt-1 text-[10px]')}>
            {isConfigured
              ? t('settings.apiKeyConfiguredHint', { label })
              : t('settings.apiKeyNotConfiguredHint', { label })}
          </p>
        </div>
      )}
    </div>
  );
}
