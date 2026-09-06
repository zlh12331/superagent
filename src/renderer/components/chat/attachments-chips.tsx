// src/renderer/components/chat/attachments-chips.tsx
// 附件 chip 列表（自 ChatInput 拆出：显示 + 移除，纯展示）
// ──────────────────────────────────────────────
// 只负责渲染附件列表与移除回调；附件数据与移除后状态更新由 ChatInput 持有。
// ──────────────────────────────────────────────

import { FileText, X } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import type { ChatAttachment } from './attachments';

/** 附件 chip 列表 props */
export interface AttachmentsChipsProps {
  /** 附件列表 */
  readonly attachments: readonly ChatAttachment[];
  /** 移除某个附件（路径定位） */
  readonly onRemove: (path: string) => void;
}

/**
 * 附件 chip 列表
 *
 * 文件名 + 移除按钮；空时不渲染。纯展示组件，可在测试中独立 mock。
 */
export function AttachmentsChips({
  attachments,
  onRemove,
}: AttachmentsChipsProps): ReactElement | null {
  const { t } = useTranslation();
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pb-1.5">
      {attachments.map((att) => (
        <span
          key={att.path}
          className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
        >
          <FileText className="size-3 shrink-0" />
          <span className="max-w-40 truncate" title={att.path}>
            {att.name}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(att.path)}
            aria-label={t('common.close')}
            className="hover:text-foreground size-auto rounded-full"
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
    </div>
  );
}
