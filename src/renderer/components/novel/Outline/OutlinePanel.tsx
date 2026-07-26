// src/renderer/components/novel/Outline/OutlinePanel.tsx
// 大纲面板组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 三级大纲列表（卷纲/章纲/节纲）
// - 支持添加新项
// - 从 IPC 获取数据
// ──────────────────────────────────────────────────────────────

import { FileText, FolderOpen, Plus, Type } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ScrollArea } from '@/components/ui/scroll-area';
import { getNovelApi } from '@/types/novel-api';

interface OutlinePanelProps {
  projectId: string;
}

const LEVEL_LABEL: Record<string, string> = {
  volume: '卷纲',
  chapter: '章纲',
  scene: '节纲',
};

export function OutlinePanel({ projectId }: OutlinePanelProps): ReactElement {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadOutlines = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getNovelApi().outline.list({ projectId });
      setItems(res.data);
    } catch {
      toast.error('加载大纲失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadOutlines();
  }, [loadOutlines]);

  const handleAdd = useCallback(
    async (level: string, parentId?: string) => {
      try {
        const label = LEVEL_LABEL[level] ?? '大纲';
        const res = await getNovelApi().outline.create(
          parentId !== undefined
            ? { projectId, level: level as 'volume' | 'chapter' | 'scene', title: `新${label}`, parentId }
            : { projectId, level: level as 'volume' | 'chapter' | 'scene', title: `新${label}` },
        );
        setItems((prev) => [...prev, res.data]);
      } catch {
        toast.error('创建大纲项失败');
      }
    },
    [projectId],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-8 text-xs">
        加载中...
      </div>
    );
  }

  // 按层级分组
  const volumes = items.filter((i) => i.level === 'volume');
  const chapters = items.filter((i) => i.level === 'chapter');
  const scenes = items.filter((i) => i.level === 'scene');

  const getChaptersByVolume = (volumeId: string) =>
    chapters.filter((c) => c.parentId === volumeId);

  const getScenesByChapter = (chapterId: string) =>
    scenes.filter((s) => s.parentId === chapterId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">大纲</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-xs transition-colors"
            onClick={() => handleAdd('volume')}
            title="添加卷纲"
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {volumes.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-xs">暂无大纲</p>
          )}

          {volumes.map((volume) => (
            <div key={volume.id}>
              {/* 卷纲 */}
              <div className="group flex items-start gap-1.5 rounded px-2 py-1 hover:bg-accent/50">
                <FolderOpen className="mt-0.5 size-3 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-xs font-medium">{volume.title}</div>
                  {volume.summary && (
                    <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                      {volume.summary}
                    </div>
                  )}
                  {volume.targetWordCount > 0 && (
                    <div className="text-muted-foreground mt-0.5 text-[10px]">
                      目标字数: {volume.targetWordCount}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 rounded px-1 py-0.5 text-[10px] transition-opacity"
                  onClick={() => handleAdd('chapter', volume.id)}
                  title="添加章纲"
                >
                  <Plus className="size-2.5" />
                </button>
              </div>

              {/* 章纲 */}
              <div className="ml-3 space-y-0.5">
                {getChaptersByVolume(volume.id).map((chapter) => (
                  <div key={chapter.id}>
                    <div className="group flex items-start gap-1.5 rounded px-2 py-1 hover:bg-accent/50">
                      <FileText className="mt-0.5 size-3 shrink-0 text-blue-400" />
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground text-xs">{chapter.title}</div>
                        {chapter.summary && (
                          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                            {chapter.summary}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 rounded px-1 py-0.5 text-[10px] transition-opacity"
                        onClick={() => handleAdd('scene', chapter.id)}
                        title="添加节纲"
                      >
                        <Plus className="size-2.5" />
                      </button>
                    </div>

                    {/* 节纲 */}
                    <div className="ml-3 space-y-0.5">
                      {getScenesByChapter(chapter.id).map((scene) => (
                        <div
                          key={scene.id}
                          className="group flex items-start gap-1.5 rounded px-2 py-1 hover:bg-accent/50"
                        >
                          <Type className="mt-0.5 size-3 shrink-0 text-green-400" />
                          <div className="min-w-0 flex-1">
                            <div className="text-muted-foreground text-[11px]">{scene.title}</div>
                            {scene.summary && (
                              <div className="text-muted-foreground mt-0.5 line-clamp-1 text-[10px]">
                                {scene.summary}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export default OutlinePanel;
