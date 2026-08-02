import type { ApiKeyProvider } from '@code-agent/shared';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    const config = MODEL_CONFIGS.find((m) => m.provider === provider);
    return config?.models.find((m) => m.id === model)?.name ?? model;
  }, [provider, model]);

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
        aria-label="选择模型"
        disabled={disabled}
      >
        <span
          className="dot"
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }}
        />
        <span>{currentProviderConfig?.label ?? provider}</span>
        <span className="text-muted-foreground text-xs">· {currentModelName}</span>
        <ChevronDown className="cpb-caret" size={10} strokeWidth={2} />
      </button>

      {open && (
        <div
          className="folder-dropdown-menu show model-selector-menu"
          role="menu"
          aria-label="模型选择"
        >
          <div className="fdm-scroll">
            {MODEL_CONFIGS.map((config) => (
              <div key={config.provider} className="model-provider-group">
                <div className="model-provider-header">
                  <span className="model-provider-icon">{config.icon}</span>
                  <span className="model-provider-label">{config.label}</span>
                </div>
                <div className="model-list">
                  {config.models.map((m) => {
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
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
