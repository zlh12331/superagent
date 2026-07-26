// src/renderer/components/novel/WorldSetting/WorldSettingPanel.tsx
// 世界观设定管理面板
// ──────────────────────────────────────────────────────────────
// 职责：
// - 按分类分组显示世界观设定
// - 支持添加/删除
// - 从 IPC 获取数据
// ──────────────────────────────────────────────────────────────

import { Globe, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ScrollArea } from '@/components/ui/scroll-area';
import { getNovelApi } from '@/types/novel-api';

interface WorldSettingPanelProps {
  projectId: string;
}

export function WorldSettingPanel({ projectId }: WorldSettingPanelProps): ReactElement {
  const [settings, setSettings] = useState<WorldSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newContent, setNewContent] = useState('');

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getNovelApi().worldSetting.list({ projectId });
      setSettings(res.data);
    } catch {
      toast.error('加载世界观设定失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 按分类分组
  const grouped = settings.reduce<Record<string, WorldSetting[]>>((acc, item) => {
    const cat = item.category || '未分类';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  const categories = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim()) return;
    try {
      const res = await getNovelApi().worldSetting.create({
        projectId,
        category: newCategory.trim() || '未分类',
        title: newTitle.trim(),
        content: newContent.trim(),
      });
      setSettings((prev) => [...prev, res.data]);
      setShowNewForm(false);
      setNewTitle('');
      setNewCategory('');
      setNewContent('');
      setExpandedCategories((prev) => new Set(prev).add(res.data.category));
    } catch {
      toast.error('创建失败');
    }
  }, [projectId, newTitle, newCategory, newContent]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await getNovelApi().worldSetting.delete({ id });
      setSettings((prev) => prev.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch {
      toast.error('删除失败');
    }
  }, [selectedId]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-8 text-xs">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">世界观设定</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-xs transition-colors"
          onClick={() => setShowNewForm(true)}
        >
          <Plus className="size-3" />
        </button>
      </div>

      {/* 新建表单 */}
      {showNewForm && (
        <div className="flex flex-col gap-2 border-b px-3 py-2">
          <input
            className="border-input bg-background text-foreground placeholder:text-muted-foreground w-full rounded border px-2 py-1 text-xs"
            placeholder="标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            autoFocus
          />
          <input
            className="border-input bg-background text-foreground placeholder:text-muted-foreground w-full rounded border px-2 py-1 text-xs"
            placeholder="分类（力量体系/地理/阵营/历史...）"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <textarea
            className="border-input bg-background text-foreground placeholder:text-muted-foreground min-h-[60px] w-full rounded border px-2 py-1 text-xs"
            placeholder="描述内容"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              className="rounded bg-primary px-2 py-1 text-xs text-white"
              onClick={handleCreate}
            >
              添加
            </button>
            <button
              type="button"
              className="text-muted-foreground rounded px-2 py-1 text-xs"
              onClick={() => setShowNewForm(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 内容 */}
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {categories.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-xs">暂无设定</p>
          ) : (
            categories.map(([category, items]) => {
              const isExpanded = expandedCategories.has(category);
              return (
                <div key={category}>
                  <button
                    type="button"
                    className="text-foreground hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium transition-colors"
                    onClick={() => toggleCategory(category)}
                  >
                    <Globe className="size-3 shrink-0" />
                    <span>{category}</span>
                    <span className="text-muted-foreground ml-auto text-[10px]">
                      {items.length}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="ml-2 space-y-0.5">
                      {items.map((item) => (
                        <div
                          key={item.id}
                          className={
                            'group flex items-start gap-1.5 rounded px-2 py-1 transition-colors' +
                            (selectedId === item.id ? ' bg-accent' : ' hover:bg-accent/50')
                          }
                          onClick={() => setSelectedId(item.id)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground text-xs">{item.title}</div>
                            {item.content && (
                              <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                                {item.content}
                              </div>
                            )}
                            {item.tags.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {item.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="bg-secondary text-secondary-foreground rounded px-1 py-0.5 text-[9px]"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 rounded p-0.5 transition-all"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDelete(item.id);
                            }}
                          >
                            <Trash2 className="size-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default WorldSettingPanel;
