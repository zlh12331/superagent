// src/renderer/components/settings/SettingsDialog.tsx
// 设置对话框 · 组装层（各域面板提取至 sections/，本文件仅编排）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 受控 Dialog：由父组件通过 open / onOpenChange 控制开关
// - 编排 9 个独立面板（API Key ×2 / 提示词 / 遥测 / 快捷键 / 用量 / 审批 / 回合 / 运行时模型 / IM 渠道 / 数据）
//
// 拆分背景（2026-08 重构）：
// - 原文件 1052 行多域混合（session/settings/im/数据导出），高内聚缺失
// - 按域提取为 sections/ 独立文件，本文件降至编排职责（<300 行）
// ──────────────────────────────────────────────────────────────

import { KeyRound } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useTranslation } from '@/i18n/use-translation';
import { ApiKeySection } from './sections/api-key-section';
import { ApprovalModeSection } from './sections/approval-mode-section';
import { DataSection } from './sections/data-section';
import { ImChannelsSection } from './sections/im-channels-section';
import { PromptSection } from './sections/prompt-section';
import { RuntimeModelsSection } from './sections/runtime-models-section';
import { ShortcutsSection } from './sections/shortcuts-section';
import { TelemetrySection } from './sections/telemetry-section';
import { TurnsSection } from './sections/turns-section';
import { UsageSection } from './sections/usage-section';

/** SettingsDialog props */
export interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 开关回调 */
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框（组装层）
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  const { t } = useTranslation();

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
        <PromptSection open={open} />

        {/* 遥测级别区块（隐私合规） */}
        <TelemetrySection />

        {/* 快捷键设置区块 */}
        <Separator className="my-2" />
        <ShortcutsSection />

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

        {/* IM 渠道区块 */}
        <Separator className="my-2" />
        <ImChannelsSection />

        {/* 数据区块（会话导出 + 打开数据目录） */}
        <Separator className="my-2" />
        <DataSection />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
