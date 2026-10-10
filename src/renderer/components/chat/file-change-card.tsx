import { FileCode, FilePlus } from 'lucide-react';
import { type ReactElement, useState } from 'react';
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
  const [open, setOpen] = useState(false);

  const path = extractPath(input);
  if (path === null || typeof input !== 'object' || input === null) return null;

  const record = input as Record<string, unknown>;
  const isCreate = toolName === 'write_file';
  const oldText = isCreate ? '' : String(record['oldString'] ?? '');
  const newText = isCreate ? String(record['content'] ?? '') : String(record['newString'] ?? '');
  const lines = computeLineDiff(oldText, newText);
  const stats = countDiffLines(lines);

  const rows = lines.map((line, i) => ({ ...line, rowKey: `${line.type}:${i}` }));
  const badgeClass = isCreate
    ? 'bg-accent-soft text-accent-text'
    : 'bg-info-blue text-accent-2-text';
  const badgeText = isCreate ? t('chat.fileChange.created') : t('chat.fileChange.modified');
  const fileName = path.split(/[\\/]/).pop() ?? path;

  return (
    <div className={cn('card tool-card is-settled', open && 'open')}>
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
                  line.type === 'add' && 'bg-accent/10 text-accent-text',
                  line.type === 'del' && 'bg-error/10 text-error-text',
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
