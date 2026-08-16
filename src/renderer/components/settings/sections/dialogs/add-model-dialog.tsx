// src/renderer/components/settings/sections/dialogs/add-model-dialog.tsx
// 添加模型弹窗（模型选择器）
// ──────────────────────────────────────────────────────────────
// 网格项 = models:list 真实清单按 providerKind 分组派生（后端单一真源，
// 空则空态不伪造）+「自定义模型」固定入口（非数据派生，始终显示）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, AvailableModelInfo } from '@code-agent/shared/renderer';
import { ChevronRight, X } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useModelsQuery } from '@/hooks/use-models';
import { useTranslation } from '@/i18n/use-translation';
import { providerLabel } from '../provider-labels';

export interface AddModelDialogProps {
  /** 弹窗开关（受控） */
  readonly open: boolean;
  /** 关闭（不选择） */
  readonly onClose: () => void;
  /** 选择厂商 → 进入配置弹窗·服务商模式 */
  readonly onSelectProvider: (kind: ApiKeyProvider) => void;
  /** 选择自定义模型 → 进入配置弹窗·自定义模式 */
  readonly onSelectCustom: () => void;
}

/** 厂商网格项（由 models:list 派生） */
interface ProviderGridItem {
  readonly kind: ApiKeyProvider;
  readonly label: string;
}

/**
 * 添加模型弹窗
 *
 * 数据源：models:list（主进程已配置可用清单）按 providerKind 去重派生厂商；
 * 未配置 API Key 的厂商其内置模型不会出现在清单中（配置好才显示）。
 */
export function AddModelDialog({
  open,
  onClose,
  onSelectProvider,
  onSelectCustom,
}: AddModelDialogProps): ReactElement {
  const { t } = useTranslation();
  const { data } = useModelsQuery();

  const providers = useMemo<readonly ProviderGridItem[]>(() => {
    const seen = new Set<ApiKeyProvider>();
    const items: ProviderGridItem[] = [];
    for (const model of (data?.models ?? []) as readonly AvailableModelInfo[]) {
      if (seen.has(model.providerKind)) continue;
      seen.add(model.providerKind);
      items.push({ kind: model.providerKind, label: providerLabel(model.providerKind) });
    }
    return items;
  }, [data]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.modelMgmt.addModelTitle')}</DialogTitle>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground absolute right-4 top-4 size-6 cursor-pointer rounded transition-colors"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          {providers.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="border-border bg-card hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors"
              onClick={() => onSelectProvider(item.kind)}
            >
              <span className="bg-accent/10 text-accent flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold">
                {item.label[0]}
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{item.label}</span>
              <ChevronRight className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.5} />
            </button>
          ))}
          {/* 自定义模型：固定入口（非数据派生，始终显示） */}
          <button
            type="button"
            className="border-border bg-card hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors"
            onClick={onSelectCustom}
          >
            <span className="bg-accent/10 text-accent flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold">
              +
            </span>
            <span className="text-foreground min-w-0 flex-1 truncate text-sm">
              {t('settings.modelMgmt.customModelEntry')}
            </span>
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.5} />
          </button>
        </div>
        {providers.length === 0 && (
          <p className="text-muted-foreground py-2 text-center text-xs">
            {t('settings.modelMgmt.noProviderHint')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
