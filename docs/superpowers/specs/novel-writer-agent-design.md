# 网文写作 Agent - 设计文档

> **版本**：1.1
> **日期**：2026-07-18
> **状态**：Q&A 决策已落实，待最终审查
> **架构方案**：方案 C — Electron + Node.js + 嵌入式 PostgreSQL

---

## 目录

1. [整体架构与进程模型](#1-整体架构与进程模型)
2. [技术栈清单](#2-技术栈清单)
3. [目录结构](#3-目录结构)
4. [模块划分与职责](#4-模块划分与职责)
5. [数据流与 IPC 契约](#5-数据流与-ipc-契约)
6. [数据模型与 Schema](#6-数据模型与-schema)
7. [错误处理与日志](#7-错误处理与日志)
8. [测试策略](#8-测试策略)
9. [项目开发规范](#9-项目开发规范)
10. [最佳实践核查记录](#10-最佳实践核查记录)

---

## 1. 整体架构与进程模型

### 1.1 进程拓扑

```
┌──────────────────────────────────────────────────────────┐
│  Electron 主进程 (Node.js / TypeScript)                  │
│  ─────────────────────────────────────────────────────   │
│  [应用生命周期]  app.whenReady / window-all-closed       │
│  [窗口管理]      BrowserWindow 工厂、多窗口、菜单        │
│  [IPC网关]      ipcMain.handle 路由到 service 层         │
│  [Service层]    Project / Chapter / Character /          │
│                 Worldview / Chat / RAG / Agent           │
│  [Repo层]       Prisma + pg → PostgreSQL                │
│  [AI客户端]     OpenAI SDK (deepseek-v4-flash)           │
│  [PG生命周期]   child_process 管理 PG 子进程             │
│                 (init / start / stop / backup)           │
│  [原生能力]     fs / dialog / shell / clipboard /       │
│                 notification / autoUpdater              │
└────────────┬─────────────────────────┬──────────────────┘
             │ contextBridge            │ child_process
             │ (preload)                │
┌────────────▼──────────────┐  ┌────────▼──────────────┐
│  渲染进程 (Chromium)       │  │  PostgreSQL 子进程    │
│  ──────────────────────── │  │  ───────────────────  │
│  React 19.2 + TS 6.0      │  │  · pgvector 扩展      │
│  状态: Zustand 5           │  │  · Apache AGE 扩展    │
│  UI: Tailwind v4 + shadcn  │  │  · 数据目录:           │
│  编辑器: TipTap 3          │  │   %APPDATA%/App/pgdata│
│  路由: React Router 7      │  └───────────────────────┘
│  IPC: window.api.* (typed) │
└────────────────────────────┘
```

### 1.2 关键设计决策

| # | 决策 | 说明 |
|---|------|------|
| 1 | `contextIsolation: true`, `nodeIntegration: false` | Electron 官方安全基线，杜绝 XSS → RCE |
| 2 | `sandbox: true` | Electron Security #4，启用渲染层沙箱 |
| 3 | 嵌入式 PG 用便携版 | 数据目录放 `%APPDATA%/<AppName>/pgdata/`，卸载不丢数据 |
| 4 | IPC 用 `ipcMain.handle` + 全量 TS 类型契约 | 类型契约单一来源 `packages/shared/ipc/api.ts` |
| 5 | API Key 存钥匙串（keytar） | 不写明文配置文件，主进程内存中使用，不回传渲染层 |
| 6 | CSP 严格定义 | `default-src 'self' app:` + 限制 connect-src |
| 7 | 限制导航与新窗口 | `will-navigate` + `setWindowOpenHandler` 白名单 |
| 8 | 生产用自定义协议 `app://` | 替代 `file://`，符合 Electron Security #18 |

### 1.3 渲染层与主进程职责边界

| 职责 | 归属 |
|------|------|
| UI 状态、表单、临时编辑草稿 | 渲染进程 |
| 业务规则、数据校验、事务 | 主进程 Service |
| 数据库访问 | 主进程 Repo（Prisma） |
| 文件 IO、对话框、通知 | 主进程（IPC 调用） |
| AI 流式响应转发 | 主进程订阅 SDK 流，逐 chunk `webContents.send` 推送 |

---

## 2. 技术栈清单

> 已校准为 2026-07-18 真实最新稳定版本。

### 2.1 运行时与构建

| 类别 | 选型 | 版本 | 理由 |
|------|------|------|------|
| 运行时 | Node.js LTS | 24.13.0 | Electron 40 内置 |
| 桌面框架 | Electron | ^40 | Chromium 134，Win11 24H2+ 兼容 |
| 构建 | electron-vite | ^5 | 适配 Vite 8 + Electron 40 |
| Vite | Vite | ^8 | 自 Vite 2 以来最重大架构变革 |
| 打包 | electron-builder | ^27 | NSIS、自动更新、签名、asar |
| 包管理 | pnpm | ^10 | workspace 性能最佳 |

### 2.2 主进程（Node.js / TypeScript）

| 类别 | 选型 | 版本 |
|------|------|------|
| 语言 | TypeScript | ^6.0 |
| ORM | Prisma | ^7 |
| AI SDK | openai | ^5（兼容 DeepSeek API） |
| 嵌入模型 | Nemotron-3-Embed-1B-BF16 | via NVIDIA NIM（OpenAI 兼容协议，2048 维） |
| 配置校验 | zod | ^4 |
| 日志 | electron-log | ^5 |
| 钥匙串 | keytar | ^7 |
| 崩溃监控 | @sentry/electron | ^5（自托管 Sentry v26.6.0） |

### 2.3 渲染进程（React 19.2 + React Compiler）

| 类别 | 选型 | 版本 |
|------|------|------|
| 框架 | React + Compiler | ^19.2 |
| 语言 | TypeScript | ^6.0 |
| 路由 | React Router | ^7（Data Mode） |
| 客户端状态 | Zustand | ^5 |
| 服务端状态 | TanStack Query | ^5.90 |
| UI 组件 | shadcn/ui + Radix | latest |
| 样式 | Tailwind CSS | v4（`@tailwindcss/vite` 插件） |
| 富文本 | TipTap | ^3 |
| 关系图 | ReactFlow | ^12 |
| 表单 | React Hook Form + zod | ^7 |
| 虚拟列表 | TanStack Virtual | ^3 |
| 通知 | sonner | ^2 |

### 2.4 PG 数据栈

| 组件 | 版本 | 部署 |
|------|------|------|
| PostgreSQL | 18.4（AGE 失败则降级 17.10） | portable |
| pgvector | latest | halfvec(2048) + HNSW |
| pgvectorscale | latest | DiskANN 索引 |
| Apache AGE | latest | Cypher over SQL |

### 2.5 质量与测试

| 类别 | 选型 | 版本 |
|------|------|------|
| Lint + 格式化 | Biome | ^2 |
| 单测 | Vitest | ^4（colocation） |
| E2E | Playwright + electron plugin | ^1.58 |
| Git Hook | husky + lint-staged | ^9 / ^15 |
| 提交规范 | commitlint + conventional commits | latest |

### 2.6 生产级监控与运维

| 类别 | 选型 | 理由 |
|------|------|------|
| 崩溃监控 | Sentry @sentry/electron + 自托管 v26.6.0 | 主进程+渲染层+IPC 全链路 |
| Sentry DSN | `http://8550a56f41fc3c8a4f0ca8ec5f8acfde@127.0.0.1:9000/2` | 自托管（项目: tauri-template，已验证可用） |
| 自动更新 | electron-updater + 私服静态托管 | 国内访问稳定 |
| 数据备份 | 自写 `pg_dump` 调度 | 每日备份到 `%APPDATA%/App/backups/` |
| 代码签名 | Windows Authenticode | 避免 SmartScreen 拦截 |
| traceId 贯穿 IPC | 渲染层生成 → IPC header → 主进程日志 | 端到端可观测 |

### 2.7 关键版本兼容矩阵（生产级钉死）

```
Electron 40 ──┬── Node 24 (内置)
              ├── Chromium 134 (内置)
              └── electron-builder 27
React 19.2 + React Compiler ── Vite 8 ── TypeScript 6.0
electron-vite 5 ── Vite 8 ── Electron 40
openai 5 ── 兼容 DeepSeek API
Prisma 7 ── 引擎 query engine 配 PG 18
pgvector + pgvectorscale ── halfvec + HNSW/DiskANN
Apache AGE latest ── PG 18 兼容
Biome 2 ── 替代 ESLint+Prettier
Vitest 4 ── Vite 8 原生
Playwright 1.58 ── Electron 40
Tailwind v4 + shadcn/ui latest + React 19.2
```

---

## 3. 目录结构

```
f:\TraeProjects\1\
├─ .github/workflows/
├─ .vscode/
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  └─ superpowers/specs/          ← 本文档所在
├─ packages/
│  ├─ shared/                    # 跨进程共享类型 + zod schema + 错误码
│  │  ├─ src/
│  │  │  ├─ ipc/                 # IPC 类型契约（单一来源）
│  │  │  │  ├─ api.ts
│  │  │  │  ├─ channels.ts
│  │  │  │  └─ payloads.ts
│  │  │  ├─ types/
│  │  │  ├─ schemas/
│  │  │  ├─ constants/
│  │  │  └─ index.ts
│  │  └─ tsconfig.json
│  └─ tsconfig/
│     ├─ base.json
│     ├─ node.json
│     └─ web.json
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ src/
│  ├─ main/                      # Electron 主进程
│  │  ├─ index.ts
│  │  ├─ app/                    # 应用生命周期、窗口、菜单
│  │  ├─ ipc/
│  │  │  ├─ router.ts
│  │  │  ├─ handlers/            # *.handler.ts + *.handler.test.ts (colocation)
│  │  │  └─ event-sender.ts
│  │  ├─ services/               # 业务逻辑层（核心）
│  │  │  └─ *.service.ts + *.service.test.ts
│  │  ├─ infra/
│  │  │  ├─ pg/                  # PG 子进程生命周期
│  │  │  ├─ prisma/
│  │  │  │  ├─ client.ts
│  │  │  │  └─ extensions/       # pgvector + age
│  │  │  ├─ ai/
│  │  │  │  ├─ openai-client.ts
│  │  │  │  ├─ deepseek-config.ts
│  │  │  │  └─ stream-bridge.ts
│  │  │  ├─ storage/             # keychain + app-data
│  │  │  └─ updater/
│  │  ├─ utils/                  # logger / errors / retry / wrap / path
│  │  └─ config/
│  ├─ preload/
│  │  ├─ index.ts
│  │  ├─ api/                    # 按业务域拆分
│  │  └─ utils/ipc-bridge.ts
│  └─ renderer/                  # React 19.2 + RR7 Data Mode
│     ├─ index.html
│     ├─ main.tsx
│     ├─ index.css               # Tailwind v4 入口
│     ├─ routes/                 # RR7 Data Mode 路由组件
│     ├─ router.tsx              # createBrowserRouter
│     ├─ providers/
│     ├─ features/               # 跨路由复用业务
│     │  ├─ chat/
│     │  └─ editor/
│     ├─ components/
│     │  └─ ui/                  # shadcn/ui 生成（@/components/ui/*）
│     ├─ stores/                 # Zustand 5 slices
│     ├─ api/                    # client + query-keys + 各业务 api
│     ├─ hooks/
│     ├─ lib/                    # utils.ts (cn()) + constants.ts
│     ├─ styles/
│     └─ types/
├─ e2e/                          # Playwright E2E
│  ├─ playwright.config.ts
│  └─ *.spec.ts
├─ resources/
│  ├─ pg/                        # 嵌入式 PG 18 二进制
│  ├─ icons/
│  └─ images/
├─ scripts/
├─ .editorconfig
├─ .gitignore
├─ .nvmrc                        # 24.13.0
├─ biome.json
├─ commitlint.config.js
├─ electron-builder.yml
├─ electron.vite.config.ts
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
└─ tsconfig.json                 # 根 tsconfig (Project References)
```

---

## 4. 模块划分与职责

### 4.1 分层架构

```
渲染层 (Routes → Features → Components → Stores → API)
    ↓ window.api.* (typed, contextBridge)
Preload (ipcRenderer.invoke → window.api)
    ↓ ipcMain.handle
IPC Handlers (薄层：参数校验 + 调 service)
    ↓
Services (业务核心，所有业务规则)
    ↓
Infra (Prisma / AI / Keychain / PG 子进程)
    ↓
PostgreSQL (pgvector / AGE)
```

### 4.2 Services 层职责矩阵

| 模块 | 职责 | 依赖 |
|------|------|------|
| project.service | 项目 CRUD、元数据、归档 | prisma |
| chapter.service | 章节/卷宗 CRUD、排序、大纲 | prisma |
| character.service | 人物卡、人物关系（AGE） | prisma + age |
| worldview.service | 世界观条目、设定集（树形） | prisma |
| chat.service | AI 对话历史、消息持久化 | prisma |
| rag.service | 文档切片、向量入库、相似检索 | prisma + pgvector + embedding.service |
| agent.service | 写作 Agent 编排：续写/改写/扩写/章节生成 | ai-client + rag + chat |
| embedding.service | 调云端生成嵌入向量 | ai-client |
| settings.service | 应用设置、API Key 读写 | keychain + prisma |

> **关键规则**：除 `agent.service` 显式编排外，service 之间不互相依赖。

### 4.3 Infra 层职责

| 模块 | 职责 |
|------|------|
| pg/pg-controller | PG 子进程生命周期 + 健康探活 |
| pg/pg-installer | 首次启动初始化（initdb + 扩展） |
| pg/pg-backup | pg_dump 备份调度 |
| prisma/client | PrismaClient 单例 |
| prisma/extensions/pgvector | 向量检索（halfvec + HNSW） |
| prisma/extensions/age | Apache AGE Cypher 透传 |
| ai/openai-client | OpenAI 5 客户端单例 |
| ai/stream-bridge | 流式响应 → IPC 事件桥接（含 AbortController） |
| storage/keychain | API Key 钥匙串 |
| storage/app-data | %APPDATA% 路径管理 |
| updater/auto-updater | 自动更新 |

### 4.4 禁止依赖方向

- ❌ Infra → Service（基础设施不能调用业务）
- ❌ Service → Handler（业务不能感知 IPC 层）
- ❌ Service A → Service B（除 agent 显式编排外）
- ❌ Renderer → Main（只能通过 window.api.*）

### 4.5 Electron 安全配置（生产级）

```ts
// src/main/app/window-manager.ts
const win = new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,        // Electron 安全基线
    nodeIntegration: false,
    sandbox: true,                 // Electron Security #4
    webSecurity: true,
  },
})

// 限制导航（Security #13）
win.webContents.on('will-navigate', (e, url) => {
  if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
    e.preventDefault()
  }
})

// 限制新窗口创建（Security #14）
win.webContents.setWindowOpenHandler(({ url }) => {
  if (url.startsWith('http')) shell.openExternal(url)
  return { action: 'deny' }
})
```

### 4.6 CSP 配置

```html
<!-- src/renderer/index.html -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self' app:;
              script-src 'self';
              style-src 'self' 'unsafe-inline';
              connect-src 'self' https://api.deepseek.com https://api.openai.com;
              img-src 'self' data: blob:;">
```

### 4.7 IPC sender 校验 + traceId 贯穿

```ts
// src/main/utils/wrap.ts
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'

/**
 * wrap(): IPC handler 统一包装器
 *
 * 职责：
 * 1. sender 校验（防止跨窗口越权）
 * 2. 自动生成 / 接收 traceId（贯穿渲染层 → IPC → 主进程日志 → Sentry）
 * 3. zod schema 校验
 * 4. try/catch + 错误分类 + Sentry 上报
 * 5. 返回统一结构 { data } | { error }
 */
export function wrap<TInput, TOutput>(
  channel: string,
  schema: z.ZodType<TInput>,
  handler: (input: TInput, ctx: IpcContext) => Promise<TOutput>,
) {
  ipcMain.handle(channel, async (evt, input: unknown, incomingTraceId?: string) => {
    // 1. traceId 生成或复用（渲染层可显式传入）
    const traceId = incomingTraceId ?? randomUUID()
    const ctx: IpcContext = { traceId, sender: evt.sender }

    // 2. sender 校验（Electron Security #17）
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) {
      logger.error({ traceId, channel }, 'IPC sender 无效')
      throw new AppError(ErrorCode.IPC_SENDER_INVALID)
    }

    // 3. zod 校验
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      logger.warn({ traceId, channel, issues: parsed.error.issues }, 'IPC 参数校验失败')
      return { error: new AppError(ErrorCode.INVALID_INPUT, undefined, parsed.error).toIpcError() }
    }

    // 4. 执行 handler，所有日志自动携带 traceId
    try {
      logger.info({ traceId, channel }, 'IPC 请求开始')
      const data = await handler(parsed.data, ctx)
      logger.info({ traceId, channel }, 'IPC 请求成功')
      return { data }
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL_ERROR, undefined, err)
      logger.error({ traceId, channel, err }, 'IPC 请求失败')
      // Sentry 上报携带 traceId，便于关联日志
      Sentry.captureException(appErr, { tags: { channel, traceId } })
      return { error: appErr.toIpcError() }
    }
  })
}
```

**Preload 注入 traceId**：

```ts
// src/preload/utils/ipc-bridge.ts
import { randomUUID } from 'node:crypto'  // preload 在 sandbox=false 下可访问

/**
 * createInvokeProxy(): 生成自动注入 traceId 的 invoke 代理
 *
 * 渲染层调用 window.api.project.create(input) 时，
 * preload 自动生成 traceId 并作为第二参数传入 ipcRenderer.invoke，
 * 主进程 wrap() 接收并贯穿到所有日志 / Sentry。
 */
export function createInvokeProxy<T extends Record<string, (...args: any[]) => Promise<any>>>(
  channels: Record<keyof T, string>,
): T {
  return new Proxy(channels, {
    get: (target, prop: string) => {
      if (!(prop in target)) return undefined
      return (...args: unknown[]) => {
        const traceId = randomUUID()
        return ipcRenderer.invoke(target[prop as keyof T], ...args, traceId)
      }
    },
  }) as T
}
```

**渲染层使用方式**（无需感知 traceId）：

```ts
// src/renderer/api/project.api.ts
export const projectApi = {
  create: (input: ProjectCreateInput) => window.api.project.create(input),
  // preload 内部已自动注入 traceId，渲染层无需关心
}
```

**traceId 贯穿链路**：

```
渲染层 api.project.create(input)
  ↓ preload 生成 traceId（UUID v4）
ipcRenderer.invoke('project:create', input, traceId)
  ↓
主进程 wrap() 接收 traceId
  ↓ ctx = { traceId, sender }
projectService.create(input, ctx)  // 所有 service 接收 ctx
  ↓ logger.info({ traceId }, ...)  // 日志贯穿
  ↓ Sentry.captureException(err, { tags: { traceId } })  // Sentry 关联
PostgreSQL 查询（可写入 comment 自动记录）
```

> **规则**：所有 IPC handler 必须用 `wrap()` 包装；所有 service 方法接收 `IpcContext` 作为第二参数；
> 所有日志和 Sentry 上报必须携带 `traceId`。这是端到端可观测性的基础。

### 4.8 Prisma 优雅关闭

```ts
// src/main/app/lifecycle.ts
app.on('before-quit', async (e) => {
  e.preventDefault()
  await prisma.$disconnect()
  await pgController.stop()
  app.exit(0)
})
```

### 4.9 Preload unsubscribe 模式

```ts
// 所有 onXxx 返回 unsubscribe，防内存泄漏
onStreamChunk: (cb) => {
  const handler = (_evt, chunk) => cb(chunk)
  ipcRenderer.on('chat:stream:chunk', handler)
  return () => ipcRenderer.removeListener('chat:stream:chunk', handler)
}
```

### 4.10 Zustand 选择性订阅

```ts
const [messages, isLoading] = useChatStore(
  (s) => [s.messages, s.isLoading],
  shallow
)
```

### 4.11 TanStack Query Mutation 失效

```ts
export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input) => window.api.project.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.list() }),
  })
}
```

---

## 5. 数据流与 IPC 契约

### 5.1 五类典型数据流

#### 场景 1：渲染层读数据（CRUD 查询）

```
React Component
  → useQuery({ queryKey, queryFn })
  → TanStack Query 缓存层（cache miss）
  → window.api.project.list()
  → Preload: ipcRenderer.invoke('project:list')
  → ipcMain.handle
  → project.handler.ts (wrap sender 校验 + zod 校验 + 调 service)
  → projectService.list()
  → prisma.project.findMany()
  → PostgreSQL
  → 返回 Project[]
  → handler wrap(projects) → { data: Project[] }
  → TanStack Query 缓存
  → Component 渲染
```

#### 场景 2：渲染层写数据（Mutation + 失效缓存）

```
React Form Submit
  → useMutation({ mutationFn, onSuccess })
  → window.api.project.create(input)
  → Preload → ipcMain.handle
  → project.handler.ts (zod 校验 + 调 service)
  → projectService.create(input)
  → prisma.project.create()
  → PostgreSQL INSERT
  → 返回 Project
  → handler 返回 { data: Project }
  → mutation onSuccess:
    qc.invalidateQueries({ queryKey: queryKeys.projects.list() })
  → TanStack Query 重新拉取 list
  → UI 自动刷新
```

#### 场景 3：AI 流式对话（核心场景）

```
用户输入消息 → 点击发送
  → window.api.chat.sendMessage({ sessionId, message })
  → Preload → ipcMain.handle('chat:sendMessage')
  → chat.handler.ts → chatService.sendMessage()
    1. 保存用户消息到 PG
    2. 构造 messages 数组（含 RAG 上下文）
    3. 调 agentService.streamGenerate()
  → agentService.streamGenerate()
    1. ragService.search() 检索相关章节/人物/世界观
    2. 构造 system prompt + 历史 + 上下文
    3. openaiClient.chat.stream.create()
  → streamBridge.subscribe(stream, webContents, 'chat:stream:{sessionId}')
  → for each chunk: webContents.send('chat:stream:chunk', { sessionId, chunk })
  → Preload: ipcRenderer.on → React state
  → UI 流式渲染（Typewriter 效果）
  → 流结束: webContents.send('chat:stream:end', { sessionId, fullText })
  → chatService.saveAssistantMessage(fullText)
  → React 触发 qc.invalidateQueries(['chat', 'messages', sessionId])
```

#### 场景 4：RAG 文档入库

```
用户上传文档
  → window.api.rag.ingestDocument({ projectId, fileContent, traceId })
  → Preload 在 invoke 第二参数注入 traceId（贯穿 IPC）
  → ragService.ingestDocument()
    1. 切片（按段落 + token 数）
    2. embeddingService.embed(chunks)
       → 调 NVIDIA NIM API（OpenAI 兼容）
       → 模型：nvidia/nemotron-3-embed-1b-bf16
       → 返回 2048 维向量数组
    3. prisma.$transaction 批量插入 DocumentChunk + halfvec(2048) 向量
  → PostgreSQL (pgvector halfvec 存储)
  → 主进程所有日志携带 traceId（贯穿 IPC）
  → 返回 { chunksCount }
  → mutation onSuccess: qc.invalidateQueries(['rag', 'documents', projectId])
```

#### 场景 5：Agent 章节生成

```
用户点击"AI 续写下一章"
  → window.api.agent.generateChapter({ projectId, prevChapterId, prompt })
  → agentService.generateChapter()
    1. chapterService.getPrevChapter() 取前文
    2. ragService.search() 检索人物/世界观/前文
    3. characterService.getCharacters() 取主要人物
    4. 构造 prompt
    5. openaiClient.chat.stream.create()
  → streamBridge 推流到渲染层
  → 流结束: chapterService.createChapter({ projectId, content: fullText })
  → qc.invalidateQueries(['chapters', projectId])
```

### 5.2 IPC Channel 命名规范

```
{domain}:{action}              # 请求-响应
{domain}:stream:{event}        # 流式事件
{domain}:event:{name}          # 状态变更事件
```

### 5.3 完整 Channel 清单

| Channel | 方向 | 用途 |
|---------|------|------|
| project:create / list / get / update / delete / archive | R→M | 项目 CRUD |
| chapter:create / list / get / update / reorder / delete | R→M | 章节 CRUD |
| character:create / list / update / delete | R→M | 人物 CRUD |
| character:getRelations / addRelation | R→M | 人物关系图（AGE） |
| worldview:create / tree / update / delete | R→M | 世界观 CRUD |
| chat:createSession / listSessions / getMessages / sendMessage / stopGeneration | R→M | AI 对话 |
| chat:stream:chunk / end / error | M→R | 流式事件 |
| rag:ingestDocument / search / listDocuments / deleteDocument | R→M | RAG |
| agent:generateChapter / rewrite / expandOutline | R→M | Agent 编排 |
| settings:get / set / setApiKey / testApiKey | R→M | 设置 |
| app:getStatus / openExternal | R→M | 应用级 |
| app:event:pgStatus | M→R | PG 状态变更通知 |

### 5.4 IPC 类型契约（单一来源）

类型定义集中在 `packages/shared/src/ipc/`，三端共享同一份类型。

```ts
// packages/shared/src/ipc/api.ts
export interface IpcApi {
  project: {
    create(input: ProjectCreateInput): Promise<IpcResponse<Project>>
    list(): Promise<IpcResponse<Project[]>>
    // ...
  }
  chat: {
    sendMessage(input: { sessionId: string; content: string }): Promise<IpcResponse<{ ackId: string }>>
    onStreamChunk: StreamSubscriber<ChatStreamChunkPayload>  // 返回 unsubscribe
    onStreamEnd: StreamSubscriber<ChatStreamEndPayload>
    onStreamError: StreamSubscriber<ChatStreamErrorPayload>
  }
  // ...
}

declare global {
  interface Window {
    api: IpcApi
  }
}
```

### 5.5 流式响应中断设计

```ts
// src/main/infra/ai/stream-bridge.ts
export class StreamBridge {
  private activeStreams = new Map<string, AbortController>()

  async streamToWebContents(sessionId, win, stream): Promise<string> {
    const controller = new AbortController()
    this.activeStreams.set(sessionId, controller)

    let fullText = ''
    for await (const chunk of stream) {
      if (controller.signal.aborted) break
      // 推 chunk 到渲染层
      win.webContents.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, { sessionId, chunk })
    }
    // ...
  }

  abort(sessionId: string) {
    this.activeStreams.get(sessionId)?.abort()
  }
}
```

---

## 6. 数据模型与 Schema

### 6.1 ER 关系总览

```
Project 1─* Volume 1─* Chapter
Project 1─* Character ←──→ CharacterRelation (AGE 图)
Project 1─* Worldview (自关联树形)
Project 1─* ChatSession 1─* ChatMessage
Project 1─* RagDocument 1─* RagDocumentChunk (halfvec)
Project 1─1 ProjectSetting
全局: AppSetting / AiUsageLog
```

### 6.2 Prisma Schema 完整定义

```prisma
generator client {
  provider = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector, age]
}

model Project {
  id          String   @id @default(cuid())
  name        String   @db.VarChar(200)
  description String?  @db.Text
  genre       String?  @db.VarChar(50)
  cover       String?
  status      ProjectStatus @default(ACTIVE)
  metadata    Json     @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  archivedAt  DateTime?

  volumes      Volume[]
  chapters     Chapter[]
  characters   Character[]
  worldviews   Worldview[]
  chatSessions ChatSession[]
  ragDocuments RagDocument[]
  setting      ProjectSetting?

  @@index([status])
  @@map("projects")
}

enum ProjectStatus { ACTIVE ARCHIVED DRAFT }

model Volume {
  id        String   @id @default(cuid())
  projectId String
  title     String   @db.VarChar(200)
  summary   String?  @db.Text
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  chapters Chapter[]

  @@index([projectId])
  @@map("volumes")
}

model Chapter {
  id        String   @id @default(cuid())
  projectId String
  volumeId  String?
  title     String   @db.VarChar(200)
  content   String   @db.Text
  wordCount Int      @default(0)
  status    ChapterStatus @default(DRAFT)
  sortOrder Int      @default(0)
  metadata  Json     @default("{}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  volume  Volume? @relation(fields: [volumeId], references: [id], onDelete: SetNull)

  @@index([projectId])
  @@index([volumeId])
  @@index([status, sortOrder])
  @@map("chapters")
}

enum ChapterStatus { DRAFT OUTLINE WRITING COMPLETED REVISION }

model Character {
  id          String   @id @default(cuid())
  projectId   String
  name        String   @db.VarChar(100)
  avatar      String?
  role        CharacterRole @default(SUPPORTING)
  description String?  @db.Text
  profile     Json     @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  // 人物关系通过 Apache AGE 图存储

  @@index([projectId])
  @@index([role])
  @@map("characters")
}

enum CharacterRole { PROTAGONIST ANTAGONIST SUPPORTING MINOR }

model Worldview {
  id        String   @id @default(cuid())
  projectId String
  parentId  String?
  title     String   @db.VarChar(200)
  content   String?  @db.Text
  type      String?  @db.VarChar(50)
  icon      String?
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent   Worldview?  @relation(fields: [parentId], references: [id], onDelete: Cascade)
  children Worldview[]

  @@index([projectId])
  @@index([parentId])
  @@map("worldviews")
}

model ChatSession {
  id        String   @id @default(cuid())
  projectId String
  title     String   @db.VarChar(200)
  context   Json     @default("{}")
  model     String?  @db.VarChar(50)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  messages ChatMessage[]

  @@index([projectId])
  @@map("chat_sessions")
}

model ChatMessage {
  id        String   @id @default(cuid())
  sessionId String
  role      ChatRole
  content   String   @db.Text
  tokens    Int      @default(0)
  metadata  Json     @default("{}")
  createdAt DateTime @default(now())

  session ChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId, createdAt])
  @@map("chat_messages")
}

enum ChatRole { user assistant system }

model RagDocument {
  id          String   @id @default(cuid())
  projectId   String
  title       String   @db.VarChar(200)
  source      String?  @db.VarChar(500)
  mimeType    String?  @db.VarChar(100)
  chunksCount Int      @default(0)
  metadata    Json     @default("{}")
  createdAt   DateTime @default(now())

  project Project           @relation(fields: [projectId], references: [id], onDelete: Cascade)
  chunks  RagDocumentChunk[]

  @@index([projectId])
  @@map("rag_documents")
}

model RagDocumentChunk {
  id         String   @id @default(cuid())
  documentId String
  content    String   @db.Text
  chunkIndex Int
  // 向量维度 = 2048（Nemotron-3-Embed-1B-BF16 官方默认维度）
  embedding  Unsupported("halfvec(2048)")
  metadata   Json     @default("{}")
  createdAt  DateTime @default(now())

  document RagDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([documentId])
  @@map("rag_document_chunks")
}

model ProjectSetting {
  projectId     String   @id
  aiModel       String   @db.VarChar(50) @default("deepseek-v4-flash")
  aiTemperature Float    @default(0.7)
  aiMaxTokens   Int      @default(4096)
  ragEnabled    Boolean  @default(true)
  ragTopK       Int      @default(5)
  ragThreshold  Float    @default(0.7)
  customPrompts Json    @default("{}")
  updatedAt     DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@map("project_settings")
}

model AppSetting {
  key       String   @id
  value     String   @db.Text
  updatedAt DateTime @updatedAt

  @@map("app_settings")
}

model AiUsageLog {
  id          String   @id @default(cuid())
  provider    String   @db.VarChar(50)
  model       String   @db.VarChar(50)
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  durationMs  Int      @default(0)
  status      String   @db.VarChar(20)
  error       String?  @db.Text
  createdAt   DateTime @default(now())

  @@index([createdAt])
  @@index([provider, model])
  @@map("ai_usage_logs")
}
```

### 6.3 Apache AGE 图数据

人物关系通过 AGE 图存储（不在 Prisma 关系表中），通过 raw SQL 透传 Cypher：

- **顶点标签**：`Character`（属性：characterId, name, role）
- **边标签**：`RELATION`（属性：type, description, chapterId）
- **查询**：通过 Prisma `$executeRawUnsafe` / `$queryRawUnsafe` 透传 Cypher

### 6.4 HNSW 索引（生产级性能）

> 向量维度固定为 2048（Nemotron-3-Embed-1B-BF16 官方默认）。halfvec 用 2 字节存储每维，
> 单条向量占用 4 KB；HNSW 索引 `m=16, ef_construction=64` 在召回率与内存占用之间取平衡。

```sql
-- 向量索引（halfvec(2048) + HNSW + 余弦距离）
CREATE INDEX idx_rag_chunks_embedding
  ON rag_document_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 大规模数据（>10 万切片）追加 pgvectorscale DiskANN 索引
-- CREATE INDEX idx_rag_chunks_diskann ON rag_document_chunks
--   USING diskann (embedding halfvec_cosine_ops)
--   WITH (num_neighbors=50, search_list_size=100);

-- 全文检索（章节内容）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_chapters_content_trgm
  ON chapters USING gin (content gin_trgm_ops);

CREATE INDEX idx_chapters_project_order
  ON chapters (project_id, sort_order);
```

### 6.5 Apache AGE 兼容性策略（PG 18 → 17.10 降级）

> AGE 官方对 PG 主版本兼容窗口通常滞后 1-2 个 minor 版本。本项目采取**默认 PG 18.4 + AGE 自动降级**策略。

**降级流程**（在 `pg/pg-installer.ts` 启动初始化时执行）：

```ts
// src/main/infra/pg/pg-installer.ts（伪代码）
async function ensureAgeExtension(): Promise<void> {
  try {
    // 1. 尝试在 PG 18.4 上加载 AGE
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS age;`)
    await prisma.$executeRawUnsafe(`LOAD 'age';`)
    await prisma.$executeRawUnsafe(`SET search_path = ag_catalog, "$user", public;`)
    logger.info({ traceId }, 'AGE 扩展加载成功（PG 18.4）')
  } catch (err) {
    // 2. AGE 加载失败 → 降级 PG 17.10
    logger.warn({ traceId, err }, 'AGE 不兼容 PG 18.4，触发降级流程')
    await pgController.stop()
    await pgInstaller.switchTo(POSTGRES_VERSIONS.V17_10)
    await pgController.start()
    // 3. 降级后重新初始化 AGE
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS age;`)
    logger.info({ traceId }, 'AGE 在 PG 17.10 上加载成功（降级完成）')
  }
}
```

**版本探测配置**：

```ts
// packages/shared/src/constants/pg-versions.ts
export const POSTGRES_VERSIONS = {
  V18_4: '18.4',   // 默认
  V17_10: '17.10', // AGE 兼容降级版本
} as const
```

**资源管理**：
- `resources/pg/18.4/` 与 `resources/pg/17.10/` 双份二进制目录
- `electron-builder.yml` 中 `extraResources` 同时打包两个版本
- 首次启动若检测到 AGE 失败，自动迁移数据目录到 17.10

### 6.6 Zod Schema（前后端共享校验）

```ts
// packages/shared/src/schemas/project.schema.ts
export const projectCreateSchema = z.object({
  name: z.string().min(1, '项目名不能为空').max(200),
  description: z.string().max(5000).optional(),
  genre: z.enum(['玄幻', '都市', '科幻', '历史', '言情', '悬疑', '其他']).optional(),
  cover: z.string().optional(),
})
```

---

## 7. 错误处理与日志

### 7.1 错误分类体系

```
渲染层错误 (RenderError)
  ↑ ipcRenderer.invoke 抛错
IPC 边界错误 (IpcError)         ← sender 校验失败、参数校验失败
  ↑
业务层错误 (ServiceError)       ← 业务规则违反
  ↑
基础设施错误
  ├─ DbError       ← Prisma 错误
  ├─ AiError       ← API 限流、超时、Key 无效
  ├─ PgProcessError ← PG 子进程崩溃
  └─ FileSystemError
```

### 7.2 错误码枚举（统一）

```ts
// packages/shared/src/constants/errors.ts
export const ErrorCode = {
  // 通用
  UNKNOWN, INTERNAL_ERROR, INVALID_INPUT, NOT_FOUND, UNAUTHORIZED, RATE_LIMITED,
  // IPC
  IPC_SENDER_INVALID, IPC_CHANNEL_NOT_FOUND,
  // 项目
  PROJECT_NOT_FOUND, PROJECT_NAME_EXISTS,
  // 章节
  CHAPTER_NOT_FOUND, CHAPTER_CONTENT_TOO_LARGE,
  // 人物
  CHARACTER_NOT_FOUND, CHARACTER_RELATION_CYCLE,
  // AI
  AI_API_KEY_MISSING, AI_API_KEY_INVALID, AI_RATE_LIMITED, AI_TIMEOUT,
  AI_MODEL_ERROR, AI_STREAM_INTERRUPTED, AI_CONTEXT_TOO_LARGE,
  // RAG
  RAG_EMBEDDING_FAILED, RAG_NO_RESULTS, RAG_DOCUMENT_TOO_LARGE,
  // 数据库
  DB_CONNECTION_FAILED, DB_QUERY_ERROR, DB_CONSTRAINT_VIOLATION,
  // PG 子进程
  PG_INIT_FAILED, PG_START_FAILED, PG_CRASHED, PG_BACKUP_FAILED,
  // 文件系统
  FS_READ_FAILED, FS_WRITE_FAILED, FS_DISK_FULL,
} as const
```

### 7.3 AppError 类

```ts
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
    public cause?: unknown,
    public details?: unknown,
  ) { super(message ?? ERROR_META[code].userMessage) }

  get meta(): ErrorMeta { return ERROR_META[this.code] }
  get retryable(): boolean { return this.meta.retryable }
  get severity(): ErrorMeta['severity'] { return this.meta.severity }

  toIpcError() { return { code: this.code, message: this.meta.userMessage, details: this.details } }
}
```

### 7.4 错误处理流程（端到端）

1. **主进程 handler** 用 `wrap()` 包装：sender 校验 + try/catch + 返回 `{ data } | { error }`
2. **Preload** unwrap：失败抛错对象（含 code）
3. **渲染层** 用 `handleIpcError()` 统一处理：toast + 操作建议按钮

### 7.5 自动重试策略

```ts
// 仅对可重试错误（AI 限流、超时、PG 崩溃）启用
// 指数退避 + 抖动：baseDelay * 2^(attempt-1) + random(500)
// 默认 maxAttempts: 3
```

### 7.6 日志体系（electron-log 5）

| 级别 | 用途 |
|------|------|
| error | 系统错误、未捕获异常 |
| warn | 可重试错误、降级行为 |
| info | 关键业务事件 |
| debug | 调试信息（dev only） |

- 文件日志：按日轮转，保留 14 天，10MB 上限
- 控制台：仅 dev 环境
- `unhandledRejection` / `uncaughtException` 全局捕获
- traceId 关联同一请求多条日志

### 7.7 Sentry 集成（自托管 v26.6.0）

**主进程初始化**（在 `app.whenReady` 之前）：

```ts
// src/main/index.ts
import * as Sentry from '@sentry/electron/main'

Sentry.init({
  dsn: 'http://8550a56f41fc3c8a4f0ca8ec5f8acfde@127.0.0.1:9000/2',
  release: `novel-writer@${app.getVersion()}`,
  environment: app.isPackaged ? 'production' : 'development',
  tracesSampleRate: 0.1,           // 采样 10% 事务
  sendDefaultPii: false,            // 不发送 PII
  beforeSend(event) {
    // 脱敏：移除可能的 API Key / 用户内容
    if (event.request?.headers?.authorization) {
      delete event.request.headers.authorization
    }
    return event
  },
})
```

**渲染层初始化**（在 `main.tsx` 顶部）：

```ts
// src/renderer/main.tsx
import * as Sentry from '@sentry/electron/renderer'

Sentry.init({
  // 渲染层无需重复配置 DSN，SDK 自动从主进程继承
  tracesSampleRate: 0.1,
})
```

**Sentry 自托管部署信息**：

| 项 | 值 |
|----|----|
| 版本 | v26.6.0（自托管） |
| DSN | `http://8550a56f41fc3c8a4f0ca8ec5f8acfde@127.0.0.1:9000/2` |
| 项目 | tauri-template（已验证可用，复用现有部署） |
| 服务地址 | http://127.0.0.1:9000 |
| Org ID | 2 |

### 7.8 PG 子进程健康监控

- 每 30 秒 ping 一次
- 崩溃自动重启（最多 3 次，指数退避）
- 状态变化通知渲染层

### 7.9 用户友好错误提示

| 错误码 | 提示 | 操作建议 |
|--------|------|---------|
| AI_API_KEY_MISSING | 请先配置 API Key | "去设置"按钮 |
| AI_API_KEY_INVALID | API Key 无效 | "重新配置"按钮 |
| AI_RATE_LIMITED | AI 调用频繁 | 自动重试 |
| AI_CONTEXT_TOO_LARGE | 上下文过长 | 提示精简对话 |
| PG_CRASHED | 数据库异常 | 自动重启 |
| FS_DISK_FULL | 磁盘空间不足 | 提示清理 |

---

## 8. 测试策略

### 8.1 测试金字塔

```
        ╱╲
       ╱  ╲           E2E (5%) - Playwright 1.58
      ╱ 5% ╲          关键用户流程
     ╱──────╲
    ╱        ╲        集成 (15%) - Testcontainers + 真 PG
   ╱   15%    ╲       IPC、Service+Prisma、AGE
  ╱────────────╲
 ╱              ╲     单元 (80%) - Vitest 4 colocation
╱      80%       ╲    Service 纯逻辑、Utils、组件
╱────────────────────╲
```

### 8.2 单元测试

- **位置**：与源码同目录 `*.test.ts`（colocation 模式）
- **范围**：Service（mock Prisma）、Utils、Zod schema、Zustand store、React 组件
- **工具**：Vitest 4 + Testing Library

### 8.3 集成测试

- **位置**：`tests/integration/`
- **范围**：Service + 真实 PG（pgvector + AGE）、IPC handler 全链路、Prisma 扩展
- **工具**：Vitest + Testcontainers（PG 18 + pgvector 镜像）

### 8.4 E2E 测试

- **位置**：`e2e/`
- **范围**：关键用户流程（新建项目 → 写作 → AI 对话）
- **工具**：Playwright 1.58 + `@playwright/test` electron plugin
- **配置**：`workers: 1`（串行）、失败时上传截图/视频/trace

### 8.5 Mock 策略

| 测试层 | Mock 对象 | 不 Mock 对象 |
|--------|----------|-------------|
| 单元测试 | Prisma、AI SDK、IPC、fs | Service 自身、Utils、Schema |
| 集成测试 | AI SDK（不依赖云端） | Prisma、PG、AGE |
| E2E 测试 | 不 Mock | 全部真实 |

### 8.6 覆盖率目标（CI 卡关）

```ts
thresholds: {
  statements: 80,
  branches: 75,
  functions: 80,
  lines: 80,
}
```

### 8.7 性能基准

| 指标 | 阈值 |
|------|------|
| 应用启动时间 | < 3s |
| IPC 调用延迟 | < 50ms（除 AI） |
| 章节列表加载（1万章节） | < 500ms |
| 向量检索（10万切片） | < 100ms (topK=5) |
| 内存占用 | < 500MB |

---

## 9. 项目开发规范

### 9.1 TypeScript 严格配置

```jsonc
// packages/tsconfig/base.json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2024"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "noEmit": true,
    "incremental": true,
    "composite": true
  }
}
```

### 9.2 Biome 2 配置

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignore": ["resources/pg/**", "release/**", "coverage/**", "node_modules/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "useExhaustiveDependencies": "warn"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsoleLog": "warn"
      },
      "style": {
        "useImportType": "error",
        "useNamingConvention": "error",
        "useConst": "error",
        "noDefaultExport": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always",
      "trailingCommas": "all",
      "arrowParentheses": "always"
    }
  },
  "overrides": [
    {
      "include": ["src/renderer/**/*.tsx"],
      "linter": {
        "rules": {
          "style": { "noDefaultExport": "off" }
        }
      }
    }
  ]
}
```

### 9.3 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件-组件 | PascalCase.tsx | `ProjectList.tsx` |
| 文件-模块 | kebab-case.ts | `project.service.ts` |
| 变量/函数 | camelCase | `getProjectList` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 类/接口/类型 | PascalCase | `class PgController`, `interface Project` |
| React 组件 | PascalCase | `function ProjectList()` |
| React hooks | use 前缀 | `useChatSession` |
| Zustand store | use + Store 后缀 | `useUiStore` |
| Enum | PascalCase + PascalCase 成员 | `enum ProjectStatus { ACTIVE }` |
| IPC channel | `domain:action` | `project:create` |
| DB 表名 | snake_case | `projects`（通过 `@@map`） |
| env 变量 | UPPER_SNAKE_CASE | `DATABASE_URL` |

### 9.4 文件长度限制

| 文件类型 | 上限 |
|---------|------|
| React 组件 | 200 行 |
| Service 文件 | 300 行 |
| 单个函数 | 50 行 |
| 测试文件 | 500 行 |

### 9.5 注释规范

- **文件头注释**：每个文件必备，描述模块职责与依赖
- **函数 JSDoc**：公开 API 必备，含 `@param` / `@returns` / `@throws` / `@example`
- **行内注释**：仅复杂逻辑，中文（用户规则）

### 9.6 函数与类设计

- 单一职责
- 公开函数 ≤ 3 个参数，超过用对象传参
- 失败优先用抛异常（不用返回码）
- 副作用隔离在 infra 层

### 9.7 React 组件规范

- 函数组件优先
- Props 用 `interface` 定义在组件上方
- 业务逻辑抽到自定义 hooks
- React Compiler 约束：组件必须无隐藏副作用

### 9.8 Conventional Commits + commitlint

```js
// commitlint.config.js（符合 Conventional Commits 1.0.0 + 官方默认规则）
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'build', 'chore', 'ci', 'docs', 'feat',
      'fix', 'perf', 'refactor', 'revert', 'style', 'test',
    ]],
    'type-case': [2, 'always', 'lowerCase'],
    'type-empty': [2, 'never'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'body-leading-blank': [1, 'always'],
    'body-max-line-length': [2, 'always', 100],
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [2, 'always', 100],
    // scope 降为 warning（Conventional Commits scope 是 optional）
    'scope-enum': [1, 'always', [
      'main', 'renderer', 'preload', 'shared', 'ipc', 'prisma',
      'ai', 'rag', 'pg', 'e2e', 'deps',
    ]],
  },
}
```

### 9.9 Husky + lint-staged（官方推荐配置）

```jsonc
// package.json
{
  "scripts": {
    "prepare": "husky",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test",
    "codegraph:sync": "codegraph sync"
  },
  "lint-staged": {
    "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc,css}": [
      "biome check --write --no-errors-on-unmatched"
    ]
  }
}
```

```bash
# .husky/pre-commit
pnpm lint-staged
pnpm codegraph sync
git add .codegraph
```

```bash
# .husky/commit-msg
pnpm commitlint --edit "$1"
```

### 9.10 分支策略

| 分支类型 | 命名 |
|---------|------|
| 主干 | `main` |
| 开发 | `develop` |
| 功能 | `feat/<scope>-<desc>` |
| 修复 | `fix/<issue>-<desc>` |
| 重构 | `refactor/<scope>-<desc>` |
| 发布 | `release/v<version>` |

### 9.11 安全规范

- API Key、密码、token 不进 git（`.env` 加入 `.gitignore`）
- 用 keytar 存钥匙串
- Electron 安全基线（见 4.5）
- SQL 参数化查询（禁止字符串拼接）
- 禁用 `dangerouslySetInnerHTML`，用 react-markdown 渲染

### 9.12 性能规范

| 指标 | 阈值 |
|------|------|
| 渲染层首屏 LCP | < 2s |
| 交互 FID | < 100ms |
| 主进程 IPC 响应 | < 50ms（除 AI） |
| PG 查询 | < 100ms（带索引） |
| 启动时间 | < 3s |
| 内存占用 | < 500MB |
| 主 chunk | < 500KB（gzip） |
| 慢查询日志 | > 200ms 记录 |

### 9.13 CodeGraph 同步规范（用户规则强制）

**每轮对话只要有代码修改**：
1. 执行 `codegraph sync`
2. 更新注释
3. git commit 一次（按 Conventional Commits）

集成到 husky pre-commit hook 自动执行。

---

## 10. 最佳实践核查记录

### 10.1 目录结构核查（修正 4 处）

| # | 修正项 | 依据 |
|---|--------|------|
| 1 | RR7 Framework Mode → Data Mode | Electron 不需要 SSR |
| 2 | shadcn/ui 别名 `@/` → `src/renderer/` | shadcn CLI 默认行为 |
| 3 | Tailwind v4 用 `@tailwindcss/vite` 插件 | 官方推荐 |
| 4 | 去掉 `packages/ui`，UI 移回 `src/renderer/components/ui/` | 非/apps/web 结构 |

### 10.2 模块设计核查（修正 9 处）

| # | 修正项 | 依据 |
|---|--------|------|
| 1 | Electron `sandbox: true` | Electron Security #4 |
| 2 | CSP meta 标签 | Electron Security #7 |
| 3 | IPC sender 校验 | Electron Security #17 |
| 4 | 限制 `will-navigate` + `setWindowOpenHandler` | Electron Security #13, #14 |
| 5 | 生产用自定义协议 `app://` | Electron Security #18 |
| 6 | Prisma `$disconnect()` 优雅关闭 | Prisma 官方 |
| 7 | Preload `onXxx` 返回 unsubscribe | Electron 官方 |
| 8 | Zustand 选择性订阅 + shallow | Zustand 官方 |
| 9 | TanStack Query mutation invalidateQueries | Practical React Query |

### 10.3 开发规范核查（修正 8 处）

| # | 修正项 | 依据 |
|---|--------|------|
| 1 | `package.json` 加 `"prepare": "husky"` | Husky 9 官方 |
| 2 | 新增 `.husky/commit-msg` 跑 commitlint | commitlint 官方 |
| 3 | lint-staged 用 `biome check --write --no-errors-on-unmatched` | Biome 官方 |
| 4 | biome.json 加 `vcs.useIgnoreFile: true` | Biome 官方 |
| 5 | commitlint `scope-enum` 从 error 降为 warning | Conventional Commits scope 是 optional |
| 6 | commitlint 显式配置 `type-case`/`subject-empty`/`subject-full-stop` | commitlint config-conventional 默认 |
| 7 | commitlint `header-max-length` 改为 100（官方默认） | commitlint 官方 |
| 8 | commitlint 加 `body/footer-leading-blank` | commitlint 官方默认 |

### 10.4 技术栈核查状态

| 技术栈 | 符合官方最佳实践 |
|--------|-----------------|
| Electron 40 | ✅ |
| electron-vite 5 | ✅ |
| electron-builder 27 | ✅ |
| React 19.2 + Compiler | ✅ |
| React Router 7 Data Mode | ✅ |
| TanStack Query 5 | ✅ |
| Zustand 5 | ✅ |
| shadcn/ui | ✅ |
| Tailwind v4（`@tailwindcss/vite`） | ✅ |
| TipTap 3 | ✅ |
| Prisma 7 | ✅ |
| Vitest 4 colocation | ✅ |
| Playwright 1.58 | ✅ |
| Biome 2 | ✅ |
| TypeScript 6 Project References | ✅ |
| pnpm workspace | ✅ |
| React Flow 12 | ✅ |
| Husky 9 + lint-staged | ✅ |
| Conventional Commits + commitlint | ✅ |

---

## 附录 A：生产级保障清单

1. **零错误零警告**：tsc + Biome 全通过，CI 卡关
2. **类型契约贯穿 IPC**：`packages/shared/ipc/api.ts` 单一来源
3. **配置校验**：zod schema 校验启动配置，fail-fast
4. **数据备份**：每日 `pg_dump` 自动备份，最近 7 份
5. **崩溃监控**：Sentry 全链路（主进程 + 渲染层 + IPC）
6. **自动更新**：electron-updater + 私服静态托管
7. **代码签名**：Windows Authenticode
8. **依赖锁**：`pnpm-lock.yaml` + `engines` + `.nvmrc` 三重锁
9. **安全基线**：contextIsolation + sandbox + CSP + sender 校验 + 导航限制
10. **CodeGraph 同步**：每次代码修改后 `codegraph sync`（强制）

## 附录 B：未决问题清单

### B.1 已确认决策（本轮 Q&A 已解决）

| # | 议题 | 最终决策 | 落实位置 |
|---|------|---------|---------|
| 1 | Apache AGE 对 PG 18 兼容性 | 默认 PG 18.4，AGE 加载失败自动降级 17.10 | §6.5 |
| 2 | Sentry DSN | `http://8550a56f41fc3c8a4f0ca8ec5f8acfde@127.0.0.1:9000/2`（自托管 v26.6.0，项目复用 tauri-template） | §2.6, §7.7 |
| 3 | RAG 嵌入模型 | Nemotron-3-Embed-1B-BF16（NVIDIA NIM, OpenAI 兼容协议, 2048 维） | §2.2, §5.1 场景 4, §6.4 |
| 4 | 向量维度 | 2048（Nemotron 官方默认） | §6.2 Prisma schema, §6.4 HNSW |
| 5 | Sentry 集成时机 | 立即集成，不留后置接口 | §7.7 |
| 6 | traceId 贯穿 IPC | 是（渲染层生成 → preload 注入 → 主进程 wrap 接收 → 日志 + Sentry） | §2.6, §4.7, §5.1 场景 4 |

### B.2 剩余未决问题（进入实现阶段再定）

| # | 议题 | 当前默认值 | 待确认要点 |
|---|------|----------|-----------|
| 1 | PG 子进程自动重启次数 | 3 次（指数退避） | 是否调整为 5 次？崩溃后是否进入只读模式？ |
| 2 | pgvectorscale DiskANN 触发阈值 | 10 万切片 | 是否按硬件配置动态调整？ |
| 3 | Sentry 事务采样率 | 0.1（10%） | 是否按环境差异化（dev=1.0, prod=0.1）？ |
| 4 | 日志保留时长 | 14 天 / 10MB 单文件 | 是否需要导出到文件供用户提交 bug？ |

---

**文档结束。等待用户审查与确认。**
