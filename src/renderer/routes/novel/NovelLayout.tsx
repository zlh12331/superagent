// src/renderer/routes/novel/NovelLayout.tsx
// 写作工作台三栏布局
// ──────────────────────────────────────────────────────────────
// 布局：
//   左侧 240px: 返回按钮 + ChapterTree
//   中间 flex-1: <Outlet /> 渲染子路由（NovelEditor）
//   右侧 288px: Tabs 切换（大纲/角色/世界观/AI对话/审查）
// ──────────────────────────────────────────────────────────────

import { ArrowLeft } from 'lucide-react';
import { type ReactElement } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';

import { ChapterTree } from '@/components/novel/ChapterTree/index';
import { CharacterPanel } from '@/components/novel/Character/CharacterPanel';
import { ChatAIAssistant } from '@/components/novel/ChatAssistant/ChatAIAssistant';
import { OutlinePanel } from '@/components/novel/Outline/OutlinePanel';
import { ReviewReportPanel } from '@/components/novel/ReviewReportPanel';
import { WorldSettingPanel } from '@/components/novel/WorldSetting/WorldSettingPanel';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ROUTES } from '@/lib/constants';

export function NovelLayout(): ReactElement {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-row">
      {/* 左侧面板：240px */}
      <aside className="flex w-[240px] shrink-0 flex-col border-r">
        {/* 返回按钮 */}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-3 py-2 text-xs transition-colors"
          onClick={() => navigate(ROUTES.novel)}
        >
          <ArrowLeft className="size-3" />
          返回项目列表
        </button>

        <Separator />

        {/* 章节树 */}
        <div className="flex-1 overflow-hidden">
          <ChapterTree projectId={projectId ?? ''} />
        </div>
      </aside>

      {/* 中间编辑器区 */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>

      {/* 右侧面板：288px */}
      <aside className="flex w-[288px] shrink-0 flex-col border-l">
        <Tabs defaultValue="outline" className="flex h-full flex-col">
          <TabsList className="mx-2 mt-2 justify-start overflow-x-auto">
            <TabsTrigger value="outline" className="text-xs">大纲</TabsTrigger>
            <TabsTrigger value="character" className="text-xs">角色</TabsTrigger>
            <TabsTrigger value="world" className="text-xs">世界观</TabsTrigger>
            <TabsTrigger value="chat" className="text-xs">AI对话</TabsTrigger>
            <TabsTrigger value="review" className="text-xs">审查</TabsTrigger>
          </TabsList>

          <TabsContent value="outline" className="overflow-hidden">
            <OutlinePanel projectId={projectId ?? ''} />
          </TabsContent>

          <TabsContent value="character" className="overflow-hidden">
            <CharacterPanel projectId={projectId ?? ''} />
          </TabsContent>

          <TabsContent value="world" className="overflow-hidden">
            <WorldSettingPanel projectId={projectId ?? ''} />
          </TabsContent>

          <TabsContent value="chat" className="overflow-hidden">
            <ChatAIAssistant projectId={projectId ?? ''} />
          </TabsContent>

          <TabsContent value="review" className="overflow-hidden">
            <ReviewReportPanel projectId={projectId ?? ''} />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );
}

export default NovelLayout;
export const Component = NovelLayout;
