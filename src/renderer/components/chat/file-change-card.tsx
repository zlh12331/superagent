// src/renderer/components/chat/file-change-card.tsx
// 文件变更 diff 卡片（对齐参考项目 superagent FileChangeCard + 原型 .diff-file）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 edit_file / write_file 工具调用的文件变更（路径 + 类型徽章 + 行级 diff）
// - diff 数据源：工具 input（edit_file: path/oldString/newString；write_file: path/content）
//   （主进程输出仅含摘要统计，before/after 内容在 input 中）
// - 交互：默认折叠，点击头部展开 diff 行（context 灰 / add 绿 / del 红）
// - 变更类型判定：write_file → created；edit_file → modified
// ──────────────────────────────────────────────────────────────

import { FileCode, FilePlus } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { computeLineDiff, countDiffLines } from '@/lib/diff/line-diff';
import { cn } from '@/lib/utils';

/** FileChangeCard props */
export interface FileChangeCardProps {
  /** 工具名（edit_file / write_file） */
  readonly toolName: string;
  /** 工具入参（edit_file: {path, oldString, newString}；write_file: {path, content}） */
  readonly input: unknown;
}

/** 从工具入参解析文件路径 */
function extractPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const path = (input as Record<string, unknown>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * 文件变更卡片
 *
 * 由 message-item 在 edit_file / write_file 工具调用时渲染（替代通用 JSON 展示）。
 */
export function FileChangeCard({ toolName, input }: FileChangeCardProps): ReactElement | null {
  const { t } = useTranslation();
  // 折叠状态（对齐 ToolCallView：默认折叠）
  const [open, setOpen] = useState(false);

  // 解析 diff 数据（input 稳定时复用）
  const parsed = useMemo(() => {
    const path = extractPath(input);
    if (path === null || typeof input !== 'object' || input === null) {
      return null;
    }
    const record = input as Record<string, unknown>;
    // write_file → 新建（无 old 内容）；edit_file → 修改（oldString/newString）
    const isCreate = toolName === 'write_file';
    const oldText = isCreate ? '' : String(record['oldString'] ?? '');
    const newText = isCreate ? String(record['content'] ?? '') : String(record['newString'] ?? '');
    const lines = computeLineDiff(oldText, newText);
    const stats = countDiffLines(lines);
    return { path, isCreate, lines, stats };
  }, [toolName, input]);

  if (parsed === null) return null;

  const { path, isCreate, lines, stats } = parsed;
  // 预构造带稳定 key 的行（diff 行无天然唯一 id：内容可重复；type+序号 组合保证稳定）
  const rows = lines.map((line, i) => ({ ...line, rowKey: `${line.type}:${i}` }));
  // 变更类型徽章：created（accent 软底）/ modified（蓝底）——纯语义令牌（照搬参考项目 FileChangeCard）
  const badgeClass = isCreate
    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
    : 'bg-[var(--info-blue)] text-[var(--accent-2)]';
  const badgeText = isCreate ? t('chat.fileChange.created') : t('chat.fileChange.modified');
  const fileName = path.split(/[\\/]/).pop() ?? path;

  return (
    <div className={cn('card tool-card', open && 'open')}>
      <button
        type="button"
        className="card-head"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('chat.toggleToolDetails')}
        aria-expanded={open}
      >
        {isCreate ? (
          <FilePlus className="card-icon size-3.5" strokeWidth={1.5} />
        ) : (
          <FileCode className="card-icon size-3.5" strokeWidth={1.5} />
        )}
        <span className="card-title max-w-[45%] truncate" title={path}>
          {fileName}
        </span>
        <span className={cn('rounded-full px-1.5 py-0.5 font-mono text-2xs', badgeClass)}>
          {badgeText}
        </span>
        <span className="card-status font-mono text-2xs">
          +{stats.additions} / -{stats.deletions}
        </span>
        <span className="tool-chev">▸</span>
      </button>
      <div className="card-body">
        {open && (
          <div className="diff-lines max-h-72 overflow-y-auto rounded border font-mono text-xs leading-[1.6]">
            {rows.map((line) => (
              <div
                key={line.rowKey}
                className={cn(
                  'flex gap-2 px-2 whitespace-pre-wrap break-all',
                  // diff 行配色：纯语义令牌（照搬参考项目 FileChangeCard，无 dark: 双写）
                  line.type === 'add' && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                  line.type === 'del' && 'bg-[var(--error)]/10 text-[var(--error)]',
                  line.type === 'context' && 'text-muted-foreground',
                )}
              >
                <span className="w-4 shrink-0 select-none text-center">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                <span className="min-w-0">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
