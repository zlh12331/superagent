// src/renderer/components/chapter/ChapterToolbar.tsx
// 章节工具栏 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Topbar 同色，融合视觉框）
// - 标题用衬线字体（呼应文学风）
// - 字数用等宽字体（呼应"墨水计数"感）
// - 保存状态颜色用设计 token：warning/success/error
// - 图标统一 strokeWidth=1.5
// - AI 按钮用 outline 变体，悬停时深棕描边
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 左侧：展示当前章节标题（truncate 防溢出）
// - 中间：用 DropdownMenu 实现状态切换器
//   下拉 5 个选项：草稿/大纲/写作中/已完成/修订中，当前状态显示 check 标记
// - 中间偏右：AI 写作按钮组（AI 续写 + AI 改写），触发回调由父组件处理
// - 右侧：实时字数 + 保存状态指示器（圆点 + 文案）
//
// 注意：
// - STATUS_LABELS 用 Map 而非对象字面量，避开 Biome useNamingConvention 对
//   UPPER_CASE 键的报错（ChapterStatus 取值为 'DRAFT' / 'OUTLINE' 等）
// - 保存状态用纯展示型圆点，颜色区分：灰(warning→idle)/琥珀(saving)/绿(success)/红(error)
// - 状态切换不触发自动保存（由父组件单独处理 status 字段更新）
// - AI 按钮用 outline 变体 + sm 尺寸，与状态切换按钮视觉一致
// - AI 续写：立即触发（无指令），后台流式生成下一章
// - AI 改写：先弹 Dialog 输入改写指令（父组件控制 Dialog），故仅触发 onRewriteClick

import { type Chapter, ChapterStatus } from '@novel-writer/shared';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
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
  /** AI 续写按钮点击回调（父组件调 useGenerateChapter） */
  onGenerateChapter: () => void;
  /** AI 改写按钮点击回调（父组件打开改写指令 Dialog） */
  onRewriteClick: () => void;
  /** 是否有 Agent 流式任务进行中（禁用 AI 按钮避免并发） */
  isAgentBusy: boolean;
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

/** 保存状态指示器配置：圆点颜色 token + 文案 */
const SAVE_STATUS_META: Record<SaveStatus, { dotClass: string; label: string }> = {
  idle: { dotClass: 'bg-muted-foreground/40', label: '' },
  saving: { dotClass: 'bg-warning', label: '保存中' },
  saved: { dotClass: 'bg-success', label: '已保存' },
  error: { dotClass: 'bg-error', label: '保存失败' },
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
 *   onGenerateChapter={() => void handleGenerate()}
 *   onRewriteClick={() => setRewriteOpen(true)}
 *   isAgentBusy={activeAckId !== null}
 * />
 */
export function ChapterToolbar({
  chapter,
  onStatusChange,
  wordCount,
  saveStatus,
  onGenerateChapter,
  onRewriteClick,
  isAgentBusy,
}: ChapterToolbarProps): ReactElement {
  const currentStatusLabel = STATUS_LABELS.get(chapter.status) ?? STATUS_LABEL_FALLBACK;
  const saveMeta = SAVE_STATUS_META[saveStatus];

  return (
    <div className="bg-sidebar border-sidebar-border flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
      {/* 左侧：章节标题（衬线字体 + truncate 防溢出） */}
      <p className="text-foreground min-w-0 flex-1 truncate font-serif text-sm font-medium tracking-wide">
        {chapter.title}
      </p>

      {/* 中间：AI 写作按钮组 + 状态切换器 */}
      <div className="flex shrink-0 items-center gap-2">
        {/* AI 续写：直接触发，无需指令 */}
        <Button
          variant="outline"
          size="sm"
          onClick={onGenerateChapter}
          disabled={isAgentBusy}
          title="AI 续写下一章（基于前文与人物设定）"
        >
          <Sparkles className="size-3.5" strokeWidth={1.5} />
          AI 续写
        </Button>
        {/* AI 改写：弹 Dialog 输入指令 */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRewriteClick}
          disabled={isAgentBusy}
          title="AI 改写当前章节正文"
        >
          <Sparkles className="size-3.5" strokeWidth={1.5} />
          AI 改写
        </Button>

        {/* 状态切换器（DropdownMenu 实现） */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {currentStatusLabel}
              <ChevronDown className="size-3.5" strokeWidth={1.5} />
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
                  <Check
                    className={cn('size-4', isCurrent ? 'opacity-100' : 'opacity-0')}
                    strokeWidth={1.5}
                  />
                  {label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 右侧：字数（等宽字体）+ 保存状态指示器 */}
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-muted-foreground font-mono text-xs tracking-wider">
          {formatWordCount(wordCount)}
        </span>
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
