// src/renderer/routes/home.tsx
// 应用首页 · 新对话入口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 NewSessionDialog（选择项目目录 → 创建会话 → 跳转）
// - 不再直接渲染 ChatPanel（Agent-Only 模式需要先绑定 workingDir）
//
// 设计：
// - 首页显示"开始新对话"入口按钮
// - 点击后打开 NewSessionDialog
// - 选择目录 + 创建会话后自动跳转 /chat/:sessionId
// ──────────────────────────────────────────────────────────────

import { Plus } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NewSessionDialog } from '@/components/chat/NewSessionDialog';
import { Button } from '@/components/ui/button';

export function HomePage(): ReactElement {
  const [dialogOpen, setDialogOpen] = useState(true);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-foreground font-serif text-2xl font-medium tracking-wide">
          Code Agent
        </h1>
        <p className="text-muted-foreground text-sm">选择一个项目目录开始对话</p>
        <Button
          size="lg"
          className="gap-2 font-serif tracking-wide"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-4" strokeWidth={1.5} />
          开始新对话
        </Button>
      </div>
      <NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default HomePage;
export const Component = HomePage;
