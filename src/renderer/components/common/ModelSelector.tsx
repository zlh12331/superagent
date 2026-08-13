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
  /**
   * 受控开关（可选）：/models 斜杠命令等外部入口打开下拉。
   * 传入后组件进入受控模式（open/onOpenChange 成对使用），
   * 不传时保持内部状态（home.tsx 等独立场景不受影响）。
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function ModelSelector({
  provider,
  model,
  onProviderChange,
  onModelChange,
  disabled = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ModelSelectorProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (next: boolean): void => {
      if (isControlled) {
        controlledOnOpenChange?.(next);
      } else {
        setInternalOpen(next);
      }
    },
    [isControlled, controlledOnOpenChange],
  );
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
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    // 打开时聚焦选中项（无选中取第一项）——键盘用户可直接 ↑↓ 导航
    const container = containerRef.current;
    if (container !== null) {
      const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const selected = items.find((el) => el.classList.contains('active')) ?? items[0];
      selected?.focus();
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen]);

  const handleModelSelect = useCallback(
    (providerKind: string, modelId: string) => {
      onProviderChange(providerKind as ApiKeyProvider);
      onModelChange(modelId);
      setOpen(false);
    },
    [onProviderChange, onModelChange, setOpen],
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
          // roving focus：↑/↓ 循环 · Home/End 首尾（此前仅 Tab 逐个停留，menu 键盘语义缺失）
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            ];
            if (items.length === 0) return;
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            let nextIndex: number | null = null;
            if (event.key === 'ArrowDown') {
              nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
            } else if (event.key === 'ArrowUp') {
              nextIndex =
                currentIndex < 0
                  ? items.length - 1
                  : (currentIndex - 1 + items.length) % items.length;
            } else if (event.key === 'Home') {
              nextIndex = 0;
            } else if (event.key === 'End') {
              nextIndex = items.length - 1;
            }
            if (nextIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            items[nextIndex]?.focus();
          }}
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
