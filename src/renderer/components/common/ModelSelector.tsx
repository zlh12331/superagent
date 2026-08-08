import type { ApiKeyProvider, RuntimeModelInfo } from '@code-agent/shared/renderer';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

interface ModelInfo {
  readonly provider: ApiKeyProvider;
  readonly label: string;
  readonly icon: string;
  readonly models: readonly { id: string; name: string }[];
}

const MODEL_CONFIGS: readonly ModelInfo[] = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    icon: 'D',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4', name: 'DeepSeek V4' },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    icon: 'O',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ],
  },
];

interface ModelSelectorProps {
  readonly provider: ApiKeyProvider;
  readonly model: string;
  readonly onProviderChange: (provider: ApiKeyProvider) => void;
  readonly onModelChange: (model: string) => void;
  readonly disabled?: boolean;
}

export function ModelSelector({
  provider,
  model,
  onProviderChange,
  onModelChange,
  disabled = false,
}: ModelSelectorProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 运行时自定义模型（后端 userData 持久化，settings:listRuntimeModels）——
  // 模型表不硬编码：内置配置仅作兜底，运行时模型动态合并
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelInfo[]>([]);
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    window.api.settings
      .listRuntimeModels()
      .then((res) => {
        if ('data' in res && res.data !== undefined) {
          setRuntimeModels([...res.data.models]);
        }
      })
      .catch(() => {
        // 运行时模型拉取失败：回退内置表（不阻断选择器）
      });
  }, []);

  // 合并模型列表：内置（兜底）+ 运行时（后端持久化，优先显示）
  const allModels = useMemo(() => {
    const builtin = MODEL_CONFIGS.flatMap((config) =>
      config.models.map((m) => ({ id: m.id, name: m.name, provider: config.provider })),
    );
    const runtime = runtimeModels.map((m) => ({
      id: m.modelId,
      name: m.modelId,
      provider: m.providerKind,
    }));
    return [...runtime, ...builtin];
  }, [runtimeModels]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const currentProviderConfig = useMemo(
    () => MODEL_CONFIGS.find((m) => m.provider === provider),
    [provider],
  );

  const currentModelName = useMemo(() => {
    return allModels.find((m) => m.id === model)?.name ?? model;
  }, [allModels, model]);

  const handleProviderSelect = useCallback(
    (p: ApiKeyProvider) => {
      onProviderChange(p);
      const config = MODEL_CONFIGS.find((m) => m.provider === p);
      if (config && config.models.length > 0) {
        const firstModel = config.models[0] ?? config.models[0];
        if (firstModel !== undefined) {
          onModelChange(firstModel.id);
        }
      }
      setOpen(false);
    },
    [onProviderChange, onModelChange],
  );

  const handleModelSelect = useCallback(
    (m: string) => {
      onModelChange(m);
      setOpen(false);
    },
    [onModelChange],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={cn('cpb-select', disabled && 'opacity-50 cursor-not-allowed')}
        onClick={() => !disabled && setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('common.selectModel')}
        disabled={disabled}
      >
        <span className="dot size-1.5 rounded-full bg-accent" />
        <span>{currentProviderConfig?.label ?? provider}</span>
        <span className="text-muted-foreground text-xs">· {currentModelName}</span>
        <ChevronDown className="cpb-caret" size={10} strokeWidth={2} />
      </button>

      {open && (
        <div
          className="folder-dropdown-menu show model-selector-menu"
          role="menu"
          aria-label={t('common.modelSelector')}
        >
          <div className="fdm-scroll">
            {/* 分组：内置配置（兜底）+ 运行时模型（后端持久化） */}
            {MODEL_CONFIGS.map((config) => {
              const runtimeForProvider = runtimeModels.filter(
                (m) => m.providerKind === config.provider,
              );
              const models = [
                ...runtimeForProvider.map((m) => ({ id: m.modelId, name: m.modelId })),
                ...config.models,
              ];
              return (
                <div key={config.provider} className="model-provider-group">
                  <div className="model-provider-header">
                    <span className="model-provider-icon">{config.icon}</span>
                    <span className="model-provider-label">{config.label}</span>
                  </div>
                  <div className="model-list">
                    {models.map((m) => {
                      const isSelected = provider === config.provider && model === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={cn('model-item', isSelected && 'active')}
                          onClick={() => {
                            handleProviderSelect(config.provider);
                            handleModelSelect(m.id);
                          }}
                          role="menuitem"
                        >
                          {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
