// src/renderer/components/novel/ChapterTree/index.tsx
// 卷-章-节树形导航组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 window.api.novel.chapter.list 获取数据
// - 卷/章可展开/折叠树
// - 高亮当前选中章节
// - 点击章节跳转到编辑器
// ──────────────────────────────────────────────────────────────

import { BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { getNovelApi } from '@/types/novel-api';

interface ChapterTreeProps {
  projectId: string;
}

export function ChapterTree({ projectId }: ChapterTreeProps): ReactElement {
  const { id: routeProjectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeChapterId = searchParams.get('chapter');

  const [volumes, setVolumes] = useState<NovelChapterVolume[]>([]);
  const [expandedVolumes, setExpandedVolumes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const pid = projectId || routeProjectId || '';

  const loadChapters = useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    try {
      const res = await getNovelApi().chapter.list({ projectId: pid });
      setVolumes(res.data);
      // 默认展开所有卷
      setExpandedVolumes(new Set(res.data.map((v: NovelChapterVolume) => v.id)));
    } catch {
      toast.error('加载章节列表失败');
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => {
    void loadChapters();
  }, [loadChapters]);

  const toggleVolume = useCallback((volumeId: string) => {
    setExpandedVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(volumeId)) {
        next.delete(volumeId);
      } else {
        next.add(volumeId);
      }
      return next;
    });
  }, []);

  const selectChapter = useCallback(
    (chapterId: string) => {
      setSearchParams({ chapter: chapterId }, { replace: true });
    },
    [setSearchParams],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-8 text-xs">
        加载中...
      </div>
    );
  }

  if (volumes.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-8">
        <BookOpen className="size-8 opacity-30" />
        <p className="text-xs">暂无章节</p>
      </div>
    );
  }

  return (
    <div className="select-none overflow-y-auto py-1">
      {volumes.map((volume) => {
        const isExpanded = expandedVolumes.has(volume.id);

        return (
          <div key={volume.id} className="px-1">
            {/* 卷标题 */}
            <button
              type="button"
              className="text-foreground hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-xs font-medium transition-colors"
              onClick={() => toggleVolume(volume.id)}
            >
              {isExpanded ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              <span className="truncate">{volume.title}</span>
            </button>

            {/* 章列表 */}
            {isExpanded && (
              <div className="ml-2">
                {volume.chapters.map((chapter) => (
                  <button
                    key={chapter.id}
                    type="button"
                    className={cn(
                      'hover:bg-accent flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
                      activeChapterId === chapter.id
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground',
                    )}
                    onClick={() => selectChapter(chapter.id)}
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{chapter.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ChapterTree;
