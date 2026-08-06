// approval-mode-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ApprovalModeSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import { Shield } from 'lucide-react';
import type { ReactElement } from 'react';

import { Label } from '@/components/ui/label';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

export function ApprovalModeSection(): ReactElement {
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
