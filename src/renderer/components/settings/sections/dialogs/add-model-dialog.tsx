// src/renderer/components/settings/sections/dialogs/add-model-dialog.tsx
// 添加模型弹窗（模型选择器）
// ──────────────────────────────────────────────────────────────
// 网格项 = 本项目已适配厂商清单（PROVIDER_LABELS，kind 单一真源为
// shared ApiKeyProviderSchema，全量展示不依赖 key 配置状态）
// +「自定义模型」固定入口（非数据派生，始终显示）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';
import { ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/use-translation';
import { PROVIDER_LABELS } from '../provider-labels';

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

/**
 * 添加模型弹窗
 *
 * 网格项 = 本项目已适配厂商（ApiKeyProviderSchema 单一真源，10 家全量）。
 * 未配置 API Key 的厂商同样展示——密钥在配置弹窗内填写（保存时落 keychain）。
 */
export function AddModelDialog({
  open,
  onClose,
  onSelectProvider,
  onSelectCustom,
}: AddModelDialogProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.modelMgmt.addModelTitle')}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          {PROVIDER_LABELS.map((item) => (
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
      </DialogContent>
    </Dialog>
  );
}
