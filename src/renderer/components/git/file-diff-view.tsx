import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { UnifiedDiffView } from '@/components/common/UnifiedDiffView';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n/use-translation';
import { basename } from '@/lib/utils';

interface FileDiffViewProps {
  readonly filePath: string;
  readonly diff: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly isLoading: boolean;
}
/** 单文件 diff 视图：新增/删除行数徽标 + diff 正文（高亮降级见文件实现） */
export function FileDiffView({
  filePath,
  diff,
  additions,
  deletions,
  isLoading,
}: FileDiffViewProps): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  const stats =
    additions !== undefined && deletions !== undefined ? { additions, deletions } : null;

  const fileName = basename(filePath);

  return (
    <div className="border-border bg-muted/20 flex h-40 flex-col border-t">
      <div className="border-border flex items-center justify-between border-b px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-auto min-w-0 flex-1 justify-start gap-1 px-0 text-2xs"
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3 shrink-0" strokeWidth={1.5} />
          )}
          <span className="font-mono truncate">{fileName}</span>
        </Button>

        {stats !== null && (
          <div className="flex shrink-0 items-center gap-1.5 text-2xs">
            <span className="text-success-text">+{stats.additions}</span>
            <span className="text-error-text">-{stats.deletions}</span>
          </div>
        )}
      </div>

      {expanded && (
        <ScrollArea className="min-h-0 flex-1">
          {isLoading ? (
            <div className="p-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="mt-1 h-3 w-1/2" />
            </div>
          ) : diff === undefined || diff.length === 0 ? (
            <div className="text-muted-foreground p-2 text-2xs">{t('common.noDiff')}</div>
          ) : (
            <UnifiedDiffView diff={diff} className="min-h-0" />
          )}
        </ScrollArea>
      )}
    </div>
  );
}
