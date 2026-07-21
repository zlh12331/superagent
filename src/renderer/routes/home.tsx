// src/renderer/routes/home.tsx
// 应用首页占位
// ──────────────────────────────────────────────────────────────
// 说明：
// - 数据库层（PostgreSQL/Prisma/AGE/pgvector/RAG/人物图谱）已全部删除，
//   原业务路由（projects/chapters/characters/worldview/chat/rag/settings）均无后端可承载。
// - 当前仅保留一个占位首页，作为 Electron 模版的最小可启动渲染层。
// - 后续若重建业务后端，在此扩展路由与组件即可。
//
// 设计：保持原极简文学风（米黄纸张底色 + 衬线字体 + 墨色文字）

import type { ReactElement } from 'react';

/**
 * 应用首页占位组件
 *
 * 展示一段欢迎文案，说明当前为模版骨架状态。
 */
export function HomePage(): ReactElement {
  return (
    <div className="text-foreground flex h-full flex-col items-center justify-center gap-4 p-12">
      <h1 className="font-serif text-3xl tracking-wide">网文写作 Agent</h1>
      <p className="text-muted-foreground font-serif text-base tracking-wide">
        当前为 Electron 模版骨架，业务后端已移除。
      </p>
    </div>
  );
}

export default HomePage;
export const Component = HomePage;
