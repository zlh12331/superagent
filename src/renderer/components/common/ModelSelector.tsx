import type { ApiKeyProvider, AvailableModelInfo } from '@code-agent/shared/renderer';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useLatestRef } from '@/hooks/use-latest-ref';
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

/**
 * 解析菜单内的 roving 焦点目标下标（纯函数）
 *
 * 收敛动机（2026-09 审计）：ArrowUp/Down/Home/End 四个平行分支此前内联在
 * onKeyDown 里，把 ModelSelector 的认知复杂度推到 18（阈值 15）。改为
 * 「按键 + 当前下标 + 总数 → 目标下标」的纯映射后，组件侧只剩一次调用。
 *
 * 边界语义：
 * - 当前无焦点项（currentIndex < 0）：↓ 落首项、↑ 落末项
 * - 循环：↓ 在末项回绕到首项，↑ 在首项回绕到末项
 * - Home/End 去首/末项
 *
 * @returns 目标下标；null 表示该键与菜单导航无关（调用方不得拦截事件）
 */
function resolveMenuNavIndex(key: string, currentIndex: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') {
    return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
  }
  if (key === 'ArrowUp') {
    return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  }
  return null;
}

/** 模型选择器（composer 右侧）：厂商/模型二级下拉，受控/非受控 open 双模式 */
export function ModelSelector({
  provider,
  model,
  onProviderChange,
  onModelChange,
  disabled = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ModelSelectorProps): ReactElement {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean): void => {
    if (isControlled) {
      controlledOnOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
  };
  const setOpenRef = useLatestRef(setOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { data: modelsData } = useModelsQuery();
  const allModels = modelsData?.models ?? [];

  const currentModelName = allModels.find((m) => m.id === model)?.label ?? model;

  const currentProvider = allModels.find((m) => m.id === model)?.providerKind ?? provider;

  const hasConfiguredModels = allModels.length > 0;

  const groups = new Map<string, AvailableModelInfo[]>();
  for (const m of allModels) {
    const list = groups.get(m.providerKind) ?? [];
    list.push(m);
    groups.set(m.providerKind, list);
  }
  const providerGroups = [...groups.entries()];

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpenRef.current(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenRef.current(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    const container = containerRef.current;
    if (container !== null) {
      const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const selected = items.find((el) => el.classList.contains('active')) ?? items[0];
      selected?.focus();
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  const handleModelSelect = (providerKind: string, modelId: string) => {
    onProviderChange(providerKind as ApiKeyProvider);
    onModelChange(modelId);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
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
            <span className="text-foreground">{currentProvider}</span>
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
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            ];
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = resolveMenuNavIndex(event.key, currentIndex, items.length);
            if (nextIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            items[nextIndex]?.focus();
          }}
        >
          <div className="fdm-scroll">
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
