// src/renderer/components/chapter/ChapterToolbar.tsx
// 章节工具栏（标题展示 + 状态切换 + 字数 + 保存状态）
// 设计文档 §5.1 数据流 + §7.10 用户友好提示
//
// 职责：
// - 左侧：展示当前章节标题（truncate 防溢出）
// - 中间：用 DropdownMenu 实现状态切换器（无 Select 组件时的替代方案）
//   下拉 5 个选项：草稿/大纲/写作中/已完成/修订中，当前状态显示 check 标记
// - 右侧：实时字数 + 保存状态指示器（圆点 + 文案）
//
// 注意：
// - STATUS_LABELS 用 Map 而非对象字面量，避开 Biome useNamingConvention 对
//   UPPER_CASE 键的报错（ChapterStatus 取值为 'DRAFT' / 'OUTLINE' 等）
// - 保存状态用纯展示型圆点，颜色区分：灰/黄/绿/红
// - 状态切换不触发自动保存（由父组件单独处理 status 字段更新）

import { type Chapter, ChapterStatus } from '@novel-writer/shared';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatWordCount } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 保存状态类型 */
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ChapterToolbarProps {
  /** 当前章节 */
  chapter: Chapter;
  /** 状态切换回调 */
  onStatusChange: (status: ChapterStatus) => void;
  /** 实时字数（来自编辑器 CharacterCount 扩展） */
  wordCount: number;
  /** 保存状态 */
  saveStatus: SaveStatus;
}

/**
 * 章节状态中文标签映射
 *
 * 覆盖 ChapterStatus 全部取值：DRAFT/OUTLINE/WRITING/COMPLETED/REVISION
 * 用 Map 而非对象字面量：Biome useNamingConvention 要求对象属性名为 camelCase，
 * 而 ChapterStatus 取值为 UPPER_CASE，用 Map 可绕开此约束。
 */
const STATUS_LABELS = new Map<ChapterStatus, string>([
  [ChapterStatus.DRAFT, '草稿'],
  [ChapterStatus.OUTLINE, '大纲'],
  [ChapterStatus.WRITING, '写作中'],
  [ChapterStatus.COMPLETED, '已完成'],
  [ChapterStatus.REVISION, '修订中'],
]);

/** 状态标签兜底值（理论上不会命中，仅为满足 Map.get() 的 undefined 返回） */
const STATUS_LABEL_FALLBACK = '未知';

/** 状态可选项数组（保持稳定引用，避免 DropdownMenu 重渲染） */
const STATUS_OPTIONS: ReadonlyArray<ChapterStatus> = [
  ChapterStatus.DRAFT,
  ChapterStatus.OUTLINE,
  ChapterStatus.WRITING,
  ChapterStatus.COMPLETED,
  ChapterStatus.REVISION,
];

/** 保存状态指示器配置：圆点颜色 + 文案 */
const SAVE_STATUS_META: Record<SaveStatus, { dotClass: string; label: string }> = {
  idle: { dotClass: 'bg-muted-foreground', label: '' },
  saving: { dotClass: 'bg-amber-500', label: '保存中' },
  saved: { dotClass: 'bg-emerald-500', label: '已保存' },
  error: { dotClass: 'bg-destructive', label: '保存失败' },
};

/**
 * 章节工具栏
 *
 * @example
 * <ChapterToolbar
 *   chapter={activeChapter}
 *   onStatusChange={(s) => void updateAsync({ id: activeChapter.id, status: s })}
 *   wordCount={wordCount}
 *   saveStatus={saveStatus}
 * />
 */
export function ChapterToolbar({
  chapter,
  onStatusChange,
  wordCount,
  saveStatus,
}: ChapterToolbarProps): ReactElement {
  const currentStatusLabel = STATUS_LABELS.get(chapter.status) ?? STATUS_LABEL_FALLBACK;
  const saveMeta = SAVE_STATUS_META[saveStatus];

  return (
    <div className="bg-card flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
      {/* 左侧：章节标题（truncate 防溢出） */}
      <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{chapter.title}</p>

      {/* 中间：状态切换器（DropdownMenu 实现） */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {currentStatusLabel}
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>章节状态</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {STATUS_OPTIONS.map((status) => {
            const label = STATUS_LABELS.get(status) ?? STATUS_LABEL_FALLBACK;
            const isCurrent = status === chapter.status;
            return (
              <DropdownMenuItem
                key={status}
                onClick={() => {
                  if (!isCurrent) onStatusChange(status);
                }}
              >
                <Check className={cn('size-4', isCurrent ? 'opacity-100' : 'opacity-0')} />
                {label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 右侧：字数 + 保存状态指示器 */}
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-muted-foreground text-xs">{formatWordCount(wordCount)}</span>
        <div className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', saveMeta.dotClass)} aria-hidden />
          {saveMeta.label.length > 0 && (
            <span className="text-muted-foreground text-xs">{saveMeta.label}</span>
          )}
        </div>
      </div>
    </div>
  );
}
