// src/renderer/routes/novel/NovelEditor.tsx
// 编辑器页面路由组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 URL 读取 projectId + chapter search param
// - 加载章节内容
// - 渲染 Editor 组件
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { Editor } from '@/components/novel/Editor/index';
import { getNovelApi } from '@/types/novel-api';

export function NovelEditor(): ReactElement {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const chapterId = searchParams.get('chapter');

  const [chapter, setChapter] = useState<NovelChapter | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChapter = useCallback(async () => {
    if (!chapterId) return;
    setLoading(true);
    try {
      const res = await getNovelApi().chapter.get({ id: chapterId });
      setChapter(res.data);
    } catch (error) {
      toast.error('加载章节失败');
    } finally {
      setLoading(false);
    }
  }, [chapterId]);

  useEffect(() => {
    void loadChapter();
  }, [loadChapter]);

  const handleSave = useCallback(
    async (content: string, title?: string) => {
      if (!chapter?.id) return;
      try {
        const saveInput: { id: string; content: string; title?: string } = {
          id: chapter.id,
          content,
        };
        if (title !== undefined) {
          saveInput.title = title;
        }
        const res = await getNovelApi().chapter.save(saveInput);
        setChapter(res.data);
        toast.success('已保存');
      } catch (error) {
        toast.error('保存失败');
      }
    },
    [chapter?.id],
  );

  if (!chapterId) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p className="text-center">
          请在左侧章节树中选择章节
          <br />
          <span className="mt-1 block text-xs">或创建新章节开始写作</span>
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        加载中...
      </div>
    );
  }

  if (!chapter) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        章节内容加载失败
      </div>
    );
  }

  return (
    <Editor
      key={chapter.id}
      title={chapter.title}
      content={chapter.content}
      projectId={projectId ?? ''}
      chapterId={chapter.id}
      onSave={handleSave}
    />
  );
}

export default NovelEditor;
export const Component = NovelEditor;
