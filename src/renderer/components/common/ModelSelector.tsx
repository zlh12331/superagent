// src/renderer/components/common/ModelSelector.tsx
// 模型选择器（composer 项目栏）
// ──────────────────────────────────────────────────────────────
// 数据源：models:list IPC——主进程 modelRegistry 真实清单
// （内置 + 运行时自定义合并，单一真源）。渲染层零硬编码模型表：
// 后端没有就是没有（浏览器模式无 window.api 时降级为空列表）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, AvailableModelInfo } from '@code-agent/shared/renderer';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useModelsQuery } from '@/hooks/use-models';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

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

  // 模型清单：共享 useModelsQuery（P3 修复：与 ModelsSection 同源同 key，
  // 新增运行时模型后 composer 下拉即时刷新）
  const { data: modelsData } = useModelsQuery();
  const allModels = modelsData?.models ?? [];

  // 当前模型展示名（来自后端清单；未知 id 回退原始 id）
  const currentModelName = useMemo(
    () => allModels.find((m) => m.id === model)?.label ?? model,
    [allModels, model],
  );

  // 当前选中模型的实际供应商（来自清单数据；未知回退 settings 值）
  const currentProvider = useMemo(
    () => allModels.find((m) => m.id === model)?.providerKind ?? provider,
    [allModels, model, provider],
  );

  // 是否已配置可用模型（空清单 = 未配置：按钮显示占位，不渲染默认配置名）
  const hasConfiguredModels = allModels.length > 0;

  // 供应商分组（按数据动态生成，顺序 = 后端返回顺序）
  const providerGroups = useMemo(() => {
    const groups = new Map<string, AvailableModelInfo[]>();
    for (const m of allModels) {
      const list = groups.get(m.providerKind) ?? [];
      list.push(m);
      groups.set(m.providerKind, list);
    }
    return [...groups.entries()];
  }, [allModels]);

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

  const handleModelSelect = useCallback(
    (providerKind: string, modelId: string) => {
      onProviderChange(providerKind as ApiKeyProvider);
      onModelChange(modelId);
      setOpen(false);
    },
    [onProviderChange, onModelChange],
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
        {hasConfiguredModels ? (
          <>
            <span>{currentProvider}</span>
            <span className="text-muted-foreground text-xs">· {currentModelName}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('common.noModelConfigured')}</span>
        )}
        <ChevronDown className="cpb-caret" size={10} strokeWidth={2} />
      </button>

      {open && (
        <div
          className="folder-dropdown-menu show model-selector-menu"
          role="menu"
          aria-label={t('common.modelSelector')}
        >
          <div className="fdm-scroll">
            {/* 分组：按后端返回的 providerKind 动态生成（无数据 = 空菜单 + 提示） */}
            {providerGroups.length === 0 ? (
              <div className="text-muted-foreground px-3 py-2 text-xs">{t('common.noModels')}</div>
            ) : (
              providerGroups.map(([providerKind, models]) => (
                <div key={providerKind} className="model-provider-group">
                  <div className="model-provider-header">
                    <span className="model-provider-icon">
                      {providerKind.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="model-provider-label">{providerKind}</span>
                  </div>
                  <div className="model-list">
                    {models.map((m) => {
                      const isSelected = provider === providerKind && model === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={cn('model-item', isSelected && 'active')}
                          onClick={() => handleModelSelect(providerKind, m.id)}
                          role="menuitem"
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
