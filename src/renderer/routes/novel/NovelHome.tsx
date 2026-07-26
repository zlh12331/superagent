// src/renderer/routes/novel/NovelHome.tsx
// 写作项目列表页
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 window.api.novel.project.list 获取项目列表
// - 网格卡片展示项目
// - "新建项目"按钮调用 window.api.novel.project.create
// ──────────────────────────────────────────────────────────────

import { BookOpen, Plus } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ROUTES } from '@/lib/constants';
import { getNovelApi } from '@/types/novel-api';

export function NovelHome(): ReactElement {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<NovelProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [newGenre, setNewGenre] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getNovelApi().project.list();
      setProjects(res.data);
    } catch (error) {
      toast.error('加载项目列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim()) {
      toast.error('请输入项目名称');
      return;
    }
    try {
      const res = await getNovelApi().project.create({
        title: newTitle.trim(),
        author: newAuthor.trim(),
        genre: newGenre.trim(),
        description: newDescription.trim(),
      });
      setShowNewForm(false);
      setNewTitle('');
      setNewAuthor('');
      setNewGenre('');
      setNewDescription('');
      navigate(ROUTES.novelProjectPath(res.data.id));
    } catch (error) {
      toast.error('创建项目失败');
    }
  }, [newTitle, newAuthor, newGenre, newDescription, navigate]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        加载中...
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-6 p-8">
      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">写作项目</h1>
          <p className="text-muted-foreground mt-1 text-sm">管理你的小说创作项目</p>
        </div>
        <Button onClick={() => setShowNewForm(true)}>
          <Plus className="size-4" />
          新建项目
        </Button>
      </div>

      {/* 新建项目表单 */}
      {showNewForm && (
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>新建项目</CardTitle>
            <CardDescription>填写基本信息开始创作</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <input
                className="border-input bg-background text-foreground placeholder:text-muted-foreground rounded-md border px-3 py-2 text-sm"
                placeholder="作品名称 *"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                autoFocus
              />
              <div className="flex gap-3">
                <input
                  className="border-input bg-background text-foreground placeholder:text-muted-foreground flex-1 rounded-md border px-3 py-2 text-sm"
                  placeholder="作者"
                  value={newAuthor}
                  onChange={(e) => setNewAuthor(e.target.value)}
                />
                <input
                  className="border-input bg-background text-foreground placeholder:text-muted-foreground flex-1 rounded-md border px-3 py-2 text-sm"
                  placeholder="题材（玄幻/都市/科幻...）"
                  value={newGenre}
                  onChange={(e) => setNewGenre(e.target.value)}
                />
              </div>
              <textarea
                className="border-input bg-background text-foreground placeholder:text-muted-foreground min-h-[80px] rounded-md border px-3 py-2 text-sm"
                placeholder="作品简介（可选）"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowNewForm(false)}>
                  取消
                </Button>
                <Button onClick={handleCreate}>创建项目</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 项目卡片网格 */}
      {projects.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-20">
          <BookOpen className="size-12 opacity-40" />
          <p>还没有写作项目</p>
          <p className="text-sm">点击上方「新建项目」开始创作</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="hover:border-primary/50 cursor-pointer transition-colors"
              onClick={() => navigate(ROUTES.novelProjectPath(project.id))}
            >
              <CardHeader>
                <CardTitle className="text-base">{project.title}</CardTitle>
                <CardDescription>
                  {project.author && `${project.author} · `}
                  {project.genre || '未分类'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground line-clamp-2 text-sm">
                  {project.description || '暂无简介'}
                </p>
                <p className="text-muted-foreground mt-3 text-xs">
                  更新于 {new Date(project.updatedAt).toLocaleDateString('zh-CN')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default NovelHome;
export const Component = NovelHome;
