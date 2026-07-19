# Phase 7: Renderer 基础（Tailwind v4 + shadcn/ui + RR7 + Zustand + TanStack Query）

> **日期**：2026-07-19
> **状态**：待执行
> **前置**：Phase 6 完成（38 channel IPC + preload IpcApi + status-broadcaster），254 测试通过

---

## 1. 目标

搭建渲染层（renderer）基础设施，为 Phase 8 业务页面铺垫完整工程化底座：

1. **样式工具链**：Tailwind v4（`@tailwindcss/vite` 插件）+ shadcn/ui 设计令牌（CSS 变量）
2. **路由**：React Router 7 Data Mode（`createBrowserRouter` + `RouterProvider`），9 条业务路由
3. **数据层**：TanStack Query 5（IPC 查询/失效）+ IPC 客户端封装（unwrap IpcResponse）
4. **状态层**：Zustand 5 stores（ui / chat-stream / app-status）
5. **错误处理**：`handleIpcError()` 统一解码 `IpcError` → sonner toast + 操作建议
6. **布局**：AppShell（Sidebar + Topbar + StatusBar + Main），路由占位 7 个 lazy 组件
7. **基础 UI 组件**：Button / Input / Label / Textarea / Card / Dialog / Dropdown / Tooltip / Sonner / ScrollArea / Separator / Tabs / Skeleton（13 个 shadcn 组件）

本 Phase **不实现业务逻辑**，路由组件仅占位（标题 + TODO 提示），数据流由 Phase 8 接入。

---

## 2. 前置条件核实

| 依赖 | 状态 | 文件 |
|------|------|------|
| IpcApi 类型（38 channel） | ✅ | packages/shared/src/ipc/api.ts |
| IpcResponse discriminated union | ✅ | packages/shared/src/ipc/response.ts |
| IpcError + ErrorCode + ERROR_META | ✅ | packages/shared/src/constants/errors.ts |
| AppError.toIpcError() | ✅ | packages/shared/src/constants/errors.ts |
| 业务实体类型（Project/Chapter/...） | ✅ | packages/shared/src/types/models.ts |
| Zod schemas（CRUD Input 派生） | ✅ | packages/shared/src/schemas/*.ts |
| preload 已暴露 window.api | ✅ | src/preload/index.ts |
| React 19.2 + React Compiler | ✅ | 已配置 babel-plugin-react-compiler |
| electron-vite 6.0.0-beta.1 | ✅ | 支持 Vite 8 |

### 2.1 缺口识别

| # | 缺口 | 影响 | 解决 |
|---|------|------|------|
| 1 | Tailwind v4 未配置 | 无法使用原子类 | Task 1 安装 + `@tailwindcss/vite` + `index.css` 重写 |
| 2 | shadcn/ui 组件库未初始化 | 业务页面无基础组件 | Task 1 手动添加 13 个组件（避免 CLI 交互） |
| 3 | React Router 未安装 | 无路由系统 | Task 2 安装 + `router.tsx` 配置 Data Mode |
| 4 | TanStack Query 未配置 | 无服务端状态缓存 | Task 2 安装 + `QueryProvider` |
| 5 | Zustand 未安装 | 无客户端状态 | Task 4 安装 + 3 个 store |
| 6 | 无 IPC 错误处理工具 | AppError 无法在渲染层展示 | Task 3 `handle-ipc-error.ts` |
| 7 | 无 AppShell 布局 | 路由无容器 | Task 5 AppShell + Sidebar + Topbar + StatusBar |
| 8 | 无路由占位 | 路由配置无组件可指 | Task 5 7 个占位组件 |

---

## 3. 文件结构

```
src/renderer/
├─ index.html                       [已有，不动]
├─ index.css                        [重写] Task 1：Tailwind v4 入口 + CSS 变量
├─ main.tsx                         [重写] Task 6：挂载 Provider + RouterProvider
├─ App.tsx                          [重写] Task 6：改为 RouterProvider 入口
├─ tsconfig.json                    [修改] Task 1：补充 paths + renderer types
├─ components.json                  [新增] Task 1：shadcn/ui 配置
├─ vite-env.d.ts                    [新增] Task 1：Vite 客户端类型
│
├─ lib/
│  ├─ utils.ts                      [新增] Task 1：cn() + 其他工具
│  └─ constants.ts                  [新增] Task 1：UI 常量（侧栏宽度等）
│
├─ types/
│  └─ ipc.d.ts                      [新增] Task 1：window.api 类型声明扩展（已由 shared 透出，此处仅 vite-env 补充）
│
├─ styles/
│  └─ globals.css                   [新增] Task 1：shadcn 设计令牌 + 暗黑模式变量
│
├─ components/
│  ├─ ui/                            [新增] Task 1：13 个 shadcn 基础组件
│  │  ├─ button.tsx
│  │  ├─ input.tsx
│  │  ├─ label.tsx
│  │  ├─ textarea.tsx
│  │  ├─ card.tsx
│  │  ├─ dialog.tsx
│  │  ├─ dropdown-menu.tsx
│  │  ├─ tooltip.tsx
│  │  ├─ sonner.tsx
│  │  ├─ scroll-area.tsx
│  │  ├─ separator.tsx
│  │  ├─ tabs.tsx
│  │  └─ skeleton.tsx
│  └─ layout/                        [新增] Task 5
│     ├─ AppShell.tsx
│     ├─ Sidebar.tsx
│     ├─ Topbar.tsx
│     └─ StatusBar.tsx
│
├─ providers/                        [新增] Task 2
│  ├─ QueryProvider.tsx              # TanStack Query 5
│  ├─ ThemeProvider.tsx              # 暗黑模式
│  └─ index.tsx                      # 组合 Provider
│
├─ router.tsx                        [新增] Task 5：createBrowserRouter
├─ routes/                           [新增] Task 5：7 个占位路由 + 根布局
│  ├─ root.tsx                       # RootLayout（含 AppShell + Outlet）
│  ├─ projects.tsx                   # /projects 列表占位
│  ├─ project-shell.tsx              # /projects/:projectId 工作台布局
│  ├─ chapters.tsx                   # /projects/:projectId/chapters
│  ├─ characters.tsx                 # /projects/:projectId/characters
│  ├─ worldview.tsx                  # /projects/:projectId/worldview
│  ├─ chat.tsx                       # /projects/:projectId/chat
│  ├─ rag.tsx                        # /projects/:projectId/rag
│  └─ settings.tsx                   # /settings
│
├─ api/                              [新增] Task 3
│  ├─ client.ts                      # unwrap + 错误抛出
│  └─ query-keys.ts                 # queryKey 工厂
│
├─ hooks/                            [新增] Task 3
│  ├─ use-ipc-query.ts               # 通用 IPC 查询 hook
│  └─ use-ipc-mutation.ts            # 通用 IPC 变更 hook
│
├─ lib/
│  └─ handle-ipc-error.ts            [新增] Task 3：错误 → toast
│
└─ stores/                           [新增] Task 4
   ├─ ui.store.ts                    # 主题、侧栏折叠
   ├─ chat-stream.store.ts           # 流式消息缓冲
   └─ app-status.store.ts            # PG/Ollama 状态订阅
```

---

## 4. Task 清单

### Task 1: 基础设施（Tailwind v4 + shadcn/ui + 工具函数 + 类型声明）

**Files:**
- Modify: `package.json`（新增依赖）
- Modify: `electron.vite.config.ts`（renderer.plugins 追加 tailwindcss）
- Modify: `src/renderer/tsconfig.json`（补充 paths）
- Rewrite: `src/renderer/index.css`（Tailwind v4 入口）
- Create: `src/renderer/vite-env.d.ts`
- Create: `src/renderer/components.json`
- Create: `src/renderer/styles/globals.css`（shadcn 设计令牌）
- Create: `src/renderer/lib/utils.ts`
- Create: `src/renderer/lib/constants.ts`
- Create: 13 个 `src/renderer/components/ui/*.tsx`

#### 1.1 依赖安装

```bash
pnpm add tailwindcss@^4 @tailwindcss/vite@^4 tw-animate-css
pnpm add class-variance-authority clsx tailwind-merge lucide-react
pnpm add sonner next-themes
pnpm add @radix-ui/react-slot @radix-ui/react-dialog @radix-ui/react-dropdown-menu \
        @radix-ui/react-tooltip @radix-ui/react-scroll-area @radix-ui/react-separator \
        @radix-ui/react-tabs @radix-ui/react-label
pnpm add react-router@^7
pnpm add @tanstack/react-query@^5
pnpm add zustand@^5
```

注意：使用 pnpm 一次安装，避免多次 lockfile 写入。next-themes 用于暗黑模式切换。

#### 1.2 electron.vite.config.ts（renderer.plugins 追加 tailwindcss）

```ts
import tailwindcss from '@tailwindcss/vite';
// ...
renderer: {
  // ...
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler']] } }),
    tailwindcss(),
  ],
},
```

#### 1.3 src/renderer/index.css 重写

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@import "./styles/globals.css";
```

#### 1.4 src/renderer/styles/globals.css（shadcn 设计令牌）

参考 shadcn/ui 官方默认令牌（neutral 主色），包含亮/暗两套 CSS 变量。

#### 1.5 src/renderer/lib/utils.ts

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

#### 1.6 13 个 shadcn/ui 基础组件

每个组件遵循 shadcn/ui 官方默认实现（基于 Radix UI），使用 `cn()` 拼接类名，支持 `className` prop 覆盖。

- `button.tsx`：buttonVariants（default/destructive/outline/secondary/ghost/link + size sm/default/lg/icon）
- `input.tsx`：基础 Input
- `textarea.tsx`：基础 Textarea
- `label.tsx`：基于 @radix-ui/react-label
- `card.tsx`：Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter
- `dialog.tsx`：基于 @radix-ui/react-dialog
- `dropdown-menu.tsx`：基于 @radix-ui/react-dropdown-menu
- `tooltip.tsx`：基于 @radix-ui/react-tooltip + TooltipProvider
- `sonner.tsx`：包装 sonner Toaster，支持主题切换
- `scroll-area.tsx`：基于 @radix-ui/react-scroll-area
- `separator.tsx`：基于 @radix-ui/react-separator
- `tabs.tsx`：基于 @radix-ui/react-tabs
- `skeleton.tsx`：骨架屏基础组件

### Task 2: Provider + Router + QueryClient 基础

**Files:**
- Create: `src/renderer/providers/QueryProvider.tsx`
- Create: `src/renderer/providers/ThemeProvider.tsx`
- Create: `src/renderer/providers/index.tsx`
- Create: `src/main`/`preload`/`renderer` 共享：暂无修改

#### 2.1 QueryProvider.tsx

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,        // 1 分钟内不重复请求
        gcTime: 5 * 60_000,      // 5 分钟后回收
        retry: 1,                // IPC 失败一般不可重试，最多 1 次
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },   // 变更不重试（用户可手动重试）
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

#### 2.2 ThemeProvider.tsx

使用 `next-themes` 实现 dark mode（参考 shadcn/ui 官方推荐，避免与 Tailwind v4 冲突）。

#### 2.3 providers/index.tsx

组合 QueryProvider + ThemeProvider + TooltipProvider + Toaster，统一导出 `AppProviders`。

### Task 3: API 客户端 + query-keys + 错误处理

**Files:**
- Create: `src/renderer/api/client.ts`
- Create: `src/renderer/api/query-keys.ts`
- Create: `src/renderer/hooks/use-ipc-query.ts`
- Create: `src/renderer/hooks/use-ipc-mutation.ts`
- Create: `src/renderer/lib/handle-ipc-error.ts`

#### 3.1 api/client.ts

```ts
import type { IpcResponse } from '@novel-writer/shared';
import { AppError } from '@novel-writer/shared';

/**
 * 解包 IPC 响应
 * 成功返回 data，失败抛 AppError（含 code/details）
 */
export function unwrap<T>(res: IpcResponse<T>): T {
  if ('error' in res) {
    throw new AppError(res.error.code, res.error.message, undefined, res.error.details);
  }
  return res.data;
}

/**
 * IPC 调用统一包装
 * 渲染层：`const projects = await apiClient.project.list();`
 */
export const apiClient = window.api; // IpcApi 实例
```

#### 3.2 api/query-keys.ts

按业务域导出 queryKey 工厂，遵循 TanStack Query 最佳实践：

```ts
export const queryKeys = {
  projects: {
    all: ['projects'] as const,
    list: () => [...queryKeys.projects.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.projects.all, 'detail', id] as const,
  },
  chapters: {
    all: ['chapters'] as const,
    list: (projectId: string) => [...queryKeys.chapters.all, 'list', projectId] as const,
    detail: (id: string) => [...queryKeys.chapters.all, 'detail', id] as const,
  },
  // ... characters / worldview / chatSessions / chatMessages / ragDocuments / settings
};
```

#### 3.3 lib/handle-ipc-error.ts

```ts
import { AppError, ERROR_META, type ErrorCode, type IpcError } from '@novel-writer/shared';
import { toast } from 'sonner';

/**
 * 统一处理 IPC 错误
 * 1. 解码 IpcError / AppError
 * 2. 根据 ErrorCode 显示 toast（含操作建议按钮）
 */
export function handleIpcError(err: unknown): void {
  const ipcError = extractIpcError(err);
  const meta = ERROR_META[ipcError.code];
  toast.error(meta.userMessage, {
    description: ipcError.message,
    action: getErrorAction(ipcError.code),
  });
}

function extractIpcError(err: unknown): IpcError {
  if (err instanceof AppError) {
    return err.toIpcError();
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return err as IpcError;
  }
  return { code: 'UNKNOWN' as ErrorCode, message: String(err) };
}
```

### Task 4: Zustand stores 基础

**Files:**
- Create: `src/renderer/stores/ui.store.ts`
- Create: `src/renderer/stores/chat-stream.store.ts`
- Create: `src/renderer/stores/app-status.store.ts`

#### 4.1 ui.store.ts

```ts
interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>()(
  subscribeWithSelector((set) => ({
    sidebarCollapsed: false,
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  })),
);
```

#### 4.2 chat-stream.store.ts

订阅 `window.api.chat.onStreamChunk / onStreamEnd / onStreamError`，按 sessionId 缓冲流式消息。

```ts
interface ChatStreamState {
  activeSessionId: string | null;
  chunksBySession: Record<string, string>;  // sessionId → 累积文本
  streamingBySession: Record<string, boolean>;
  appendChunk: (sessionId: string, chunk: string) => void;
  endStream: (sessionId: string, fullText: string) => void;
  errorStream: (sessionId: string, message: string) => void;
  setActiveSession: (id: string | null) => void;
}
```

#### 4.3 app-status.store.ts

订阅 `window.api.app.onPgStatusChange / onOllamaStatusChange / onOllamaPullProgress`，缓存最新状态供 StatusBar 显示。

```ts
interface AppStatusState {
  pgStatus: 'starting' | 'running' | 'stopped' | 'crashed';
  ollamaStatus: 'starting' | 'running' | 'stopped' | 'not_installed';
  ollamaModelReady: boolean;
  dbConnected: boolean;
  pullProgress: { model: string; percent: number } | null;
  refresh: () => Promise<void>;
  init: () => () => void;  // 订阅并返回 cleanup
}
```

### Task 5: AppShell 布局 + 路由占位

**Files:**
- Create: `src/renderer/components/layout/AppShell.tsx`
- Create: `src/renderer/components/layout/Sidebar.tsx`
- Create: `src/renderer/components/layout/Topbar.tsx`
- Create: `src/renderer/components/layout/StatusBar.tsx`
- Create: `src/renderer/router.tsx`
- Create: 8 个 `src/renderer/routes/*.tsx`（root + 7 占位）

#### 5.1 AppShell.tsx

布局结构：

```
┌─────────────────────────────────────────────┐
│ Topbar（44px）                              │
├──────────┬──────────────────────────────────┤
│ Sidebar  │ Outlet（业务路由）              │
│ 240px    │                                  │
│          │                                  │
├──────────┴──────────────────────────────────┤
│ StatusBar（28px，PG/Ollama 状态）           │
└─────────────────────────────────────────────┘
```

#### 5.2 router.tsx

```ts
import { createBrowserRouter } from 'react-router';
import { RootLayout } from './routes/root';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, lazy: () => import('./routes/projects') },
      { path: 'settings', lazy: () => import('./routes/settings') },
      {
        path: 'projects/:projectId',
        lazy: () => import('./routes/project-shell'),
        children: [
          { index: true, lazy: () => import('./routes/chapters') },
          { path: 'chapters', lazy: () => import('./routes/chapters') },
          { path: 'characters', lazy: () => import('./routes/characters') },
          { path: 'worldview', lazy: () => import('./routes/worldview') },
          { path: 'chat', lazy: () => import('./routes/chat') },
          { path: 'rag', lazy: () => import('./routes/rag') },
        ],
      },
    ],
  },
]);
```

#### 5.3 路由占位组件

每个占位组件仅展示标题 + TODO 提示，不实现业务逻辑：

```tsx
export function ChaptersPage(): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>章节管理</CardTitle>
        <CardDescription>Phase 8 实现</CardDescription>
      </CardHeader>
      <CardContent>章节列表 + 编辑器（TipTap 3）将在此处</CardContent>
    </Card>
  );
}
```

### Task 6: 集成 + 自检 + 提交

**Files:**
- Rewrite: `src/renderer/main.tsx`
- Rewrite: `src/renderer/App.tsx`

#### 6.1 main.tsx

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('根节点 #root 未找到');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

#### 6.2 App.tsx

```tsx
import { RouterProvider } from 'react-router';
import { AppProviders } from './providers';
import { router } from './router';

export default function App(): ReactElement {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
```

#### 6.3 验收清单

| # | 项目 | 命令 | 期望 |
|---|------|------|------|
| 1 | 依赖安装 | `pnpm install` | 无错误 |
| 2 | 类型检查 | `pnpm typecheck` | 0 errors |
| 3 | Lint | `pnpm lint` | 0 errors |
| 4 | 构建 | `pnpm build` | 三入口产物生成（main + preload + renderer） |
| 5 | 启动 dev | `pnpm dev` | 窗口启动，渲染层显示 AppShell（不崩溃） |
| 6 | 测试 | `pnpm test` | 主进程 + shared 测试全部通过（不增不减） |
| 7 | CodeGraph 同步 | `codegraph sync` | 成功 |

---

## 5. 关键设计决策

### 5.1 Tailwind v4 vs v3

- **选 v4**：`@tailwindcss/vite` 原生 Vite 插件，零 PostCSS 配置；设计文档 §2.3 已钉死 v4
- **CSS 入口**：`@import "tailwindcss"` 替代 v3 的 `@tailwind base/components/utilities`
- **设计令牌**：通过 CSS 变量（`--background` / `--foreground`）+ `@theme inline` 映射到 Tailwind 类
- **暗黑模式**：`@custom-variant dark (&:is(.dark *))` + `next-themes` 切换 `.dark` class

### 5.2 shadcn/ui 手动添加（不走 CLI）

- **原因**：shadcn CLI 是交互式的（需要回答 prompts），不适合自动化；且项目已定制 biome + tsconfig，CLI 默认 ESLint 配置会冲突
- **方式**：直接复制 shadcn/ui 官方源码（每个组件都是从 radix 包装的薄层）
- **依赖**：每个组件依赖对应的 `@radix-ui/react-*` 包

### 5.3 React Router 7 Data Mode（非 Framework Mode）

- **Data Mode**：`createBrowserRouter` + `RouterProvider`，纯客户端路由
- **Framework Mode**：需要 RR7 项目脚手架（next.js 风格），与 Electron 不兼容
- **lazy()**：用 `lazy: () => import('./routes/xxx')` 实现路由级代码分割
- **错误边界**：每个路由可定义 `errorElement`

### 5.4 TanStack Query 配置

- `staleTime: 60_000`：1 分钟内不重复请求（IPC 调用是有成本的，避免频繁刷新）
- `retry: 1`：IPC 失败一般不可重试（业务错误而非网络错误），但 1 次重试抵御偶发抖动
- `refetchOnWindowFocus: false`：Electron 单窗口应用，focus 事件频繁
- `mutations.retry: 0`：变更操作不自动重试，避免重复创建

### 5.5 Zustand 5 + subscribeWithSelector

- **5 的变化**：默认不导出 `create`，需 `import { create } from 'zustand'`
- **选择性订阅**：`useUiStore((s) => s.sidebarCollapsed)`，避免全量渲染
- **持久化**：UI 状态（侧栏折叠、主题）可考虑用 `persist` 中间件，但 Phase 7 暂不引入（next-themes 已处理主题持久化）

### 5.6 IPC 客户端封装（unwrap 模式）

- **设计**：`unwrap<T>(res: IpcResponse<T>): T` 失败抛 `AppError`
- **优点**：调用方写 `const projects = await unwrap(apiClient.project.list())`，错误用 try/catch 或 mutation onError 处理
- **替代方案**：返回 `Result<T, AppError>`（函数式风格）—— 但与 React / TanStack Query 习惯不符，未采纳

### 5.7 路由懒加载 + lazy 组件

- **lazy()**：RR7 原生支持，自动代码分割
- **占位组件**：Phase 7 仅展示标题 + TODO，Phase 8 替换为真实业务页面
- **避免预加载**：Phase 7 不引入 `preload`，Phase 8 视情况添加

### 5.8 不引入 TipTap / ReactFlow / TanStack Virtual

- **原因**：Phase 7 是基础设施，这三个库是业务页面专用（编辑器、关系图、虚拟列表）
- **Phase 8 再装**：避免 Phase 7 依赖爆炸，启动慢

### 5.9 主题切换使用 next-themes（非自实现）

- **原因**：shadcn/ui 官方推荐 next-themes，与 Tailwind v4 兼容性好
- **实现**：`<ThemeProvider attribute="class" defaultTheme="system">`，给 `<html>` 加 `.dark` class

### 5.10 路由目录命名（kebab-case）

- **路由文件**：`routes/chapters.tsx` / `routes/project-shell.tsx`（kebab-case，符合 biome useNamingConvention）
- **导出函数**：`ChaptersPage` / `ProjectShell`（PascalCase，符合 React 组件命名）
- **lazy 导出**：每个路由文件 `export function Component()` 即可（RR7 lazy 约定）

---

## 6. 执行策略

### 6.1 串行 + 并行混合

```
Task 1 (主代理串行)
  ├─ 安装依赖
  ├─ 配置 Vite + Tailwind
  ├─ 创建 globals.css + utils.ts
  └─ 创建 13 个 shadcn 组件（子代理并行）

Task 2/3/4 (3 个子代理并行)
  ├─ Task 2: Provider + Router + QueryClient
  ├─ Task 3: API client + hooks + 错误处理
  └─ Task 4: 3 个 Zustand store

Task 5 (主代理串行)
  ├─ AppShell + Sidebar + Topbar + StatusBar
  └─ router.tsx + 8 个路由占位

Task 6 (主代理串行)
  ├─ main.tsx + App.tsx 重写
  ├─ 验收清单全部通过
  ├─ codegraph sync
  └─ git commit（每完成一个 Task 提交一次）
```

### 6.2 子代理边界

- **Task 1 子代理**：只负责创建 13 个 shadcn 组件文件（已知路径，不需探索）
- **Task 2/3/4 子代理**：各自独立目录（providers/、api/+hooks/、stores/），无文件冲突
- **Task 5 主代理**：依赖 Task 1-4 全部完成（Sidebar 用 ui/button，Router 引用 routes/）

### 6.3 提交策略

按 Task 粒度提交（用户规则：每轮对话只要有代码修改过就 git 提交一次 + codegraph sync）：

1. `chore(deps): 安装 Phase 7 渲染层依赖`（Task 1.1）
2. `feat(renderer): Tailwind v4 + shadcn/ui 基础设施 + 13 个 UI 组件`（Task 1 完成）
3. `feat(renderer): Provider + Router + QueryClient 配置`（Task 2）
4. `feat(renderer): API 客户端 + query-keys + IPC 错误处理`（Task 3）
5. `feat(renderer): Zustand 5 stores 基础`（Task 4）
6. `feat(renderer): AppShell 布局 + 8 个路由占位`（Task 5）
7. `feat(renderer): 集成 main.tsx + App.tsx 完成 Phase 7`（Task 6）

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Tailwind v4 与 Electron Vite 8 兼容性 | `@tailwindcss/vite` 是官方 Vite 插件，零配置；若失败回退 PostCSS 模式 |
| shadcn 组件手抄遗漏 biome 规则 | 子代理执行后主代理跑 `pnpm lint --write` 一次性修复 |
| next-themes 与 Electron 沙箱冲突 | next-themes 只操作 DOM class，无 fs / node 依赖，沙箱兼容 |
| RR7 lazy() 在 Electron file:// 加载失败 | electron-vite dev 用 dev server（http://localhost:5173），prod 用 file:// 但已打包为单 chunk |
| React Compiler 与 shadcn 组件冲突 | shadcn 组件纯函数无副作用，React Compiler 自动 memoize 安全 |
| Zustand 5 breaking change（不导出 create） | 已确认 `import { create } from 'zustand'`，参考 v5 migration guide |

---

## 8. 验收清单

- [ ] `pnpm install` 无错误
- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors（含新增 30+ 文件）
- [ ] `pnpm build` 三入口产物生成
- [ ] `pnpm dev` 启动后窗口能显示 AppShell（Sidebar + Topbar + StatusBar），不崩溃
- [ ] `pnpm test` 通过（Phase 6 的 254 测试不被破坏）
- [ ] `codegraph sync` 成功
- [ ] 7 个 git commit（按 Task 粒度）
