# Phase 8: Renderer 业务页面（项目/章节/人物/世界观/AI对话/RAG/设置）

> **日期**：2026-07-19
> **状态**：待执行
> **前置**：Phase 7 完成（AppShell + 9 路由占位 + Provider + Zustand stores + IPC hooks），254 测试通过

---

## 1. 目标

将 Phase 7 的 9 个路由占位组件替换为可交互的业务页面，覆盖网文写作 Agent 全部业务流程：

1. **项目列表页**（`/projects`）：项目卡片网格、新建/归档/删除项目、搜索过滤
2. **章节管理页**（`/projects/:projectId/chapters`）：章节列表 + TipTap 3 富文本编辑器 + 章节状态切换 + 拖拽排序
3. **人物卡页**（`/projects/:projectId/characters`）：人物卡片网格 + 人物表单 + ReactFlow 关系图
4. **世界观页**（`/projects/:projectId/worldview`）：递归树形视图 + 节点编辑面板
5. **AI 对话页**（`/projects/:projectId/chat`）：会话列表 + 流式消息渲染 + 输入框 + 停止生成
6. **RAG 文档页**（`/projects/:projectId/rag`）：文档列表 + 文件上传 + 检索测试面板
7. **设置页**（`/settings`）：DeepSeek API Key + Ollama 配置 + AI 模型参数 + 项目级设置入口

本 Phase 不引入新业务 service，全部消费 Phase 5 已实现的 9 个 service + Phase 6 的 38 个 IPC channel。

---

## 2. 前置条件核实

| 依赖 | 状态 | 文件 |
|------|------|------|
| 9 个实体类型（Project/Chapter/...） | ✅ | packages/shared/src/types/models.ts |
| 7 个 Zod schema（CRUD Input） | ✅ | packages/shared/src/schemas/*.ts |
| 38 IPC channel（IpcApi） | ✅ | packages/shared/src/ipc/api.ts |
| AppError + ErrorCode + ERROR_META | ✅ | packages/shared/src/constants/errors.ts |
| 9 个 service | ✅ | src/main/services/*.service.ts |
| Tailwind v4 + shadcn/ui（13 组件） | ✅ | src/renderer/components/ui/*.tsx |
| Provider 层（QueryClient/Theme/AppProviders） | ✅ | src/renderer/providers/*.tsx |
| API 客户端 + query-keys + IPC hooks | ✅ | src/renderer/api/*.ts + hooks/*.ts |
| 3 个 Zustand store | ✅ | src/renderer/stores/*.ts |
| AppShell + Sidebar + Topbar + StatusBar | ✅ | src/renderer/components/layout/*.tsx |
| RR7 router + 9 路由占位 | ✅ | src/renderer/router.tsx + routes/*.tsx |

### 2.1 缺口识别

| # | 缺口 | 影响 | 解决 |
|---|------|------|------|
| 1 | 9 个路由占位仅展示 Card，无业务功能 | 用户无法操作业务 | Task 1-7 替换为真实业务页面 |
| 2 | 缺少领域特定 hooks（useProjects/useChapters 等） | 组件直接调 apiClient 难复用 | Task 1 创建 hooks/use-projects.ts 等 8 个领域 hook 文件 |
| 3 | 章节编辑器无富文本能力 | 用户无法编辑章节内容 | Task 2 引入 TipTap 3（StarterKit + Placeholder） |
| 4 | 人物关系图无可视化 | 用户难以理解人物关系网络 | Task 3 引入 @xyflow/react（ReactFlow） |
| 5 | 世界观树无递归组件 | 无法展示层级结构 | Task 4 创建 WorldviewTree 递归组件 |
| 6 | 聊天流式无订阅 | 无法接收 AI 实时回复 | Task 5 集成 chat-stream.store + useEffect 订阅 onStreamChunk |
| 7 | RAG 文件上传无通道 | IPC 不支持文件流传输 | Task 6 用 FileReader 读取为 text + 通过 fileContent 字符串传输（设计文档 §5.3 明确不传二进制） |
| 8 | 设置页错误处理 onClick 占位 | handle-ipc-error getErrorAction 返回空函数 | Task 7 接入 useNavigate 跳转 |

---

## 3. 文件结构

```
src/renderer/
├─ hooks/                                [Task 1 新增 8 个领域 hooks]
│  ├─ use-projects.ts                    # 项目 CRUD（4 hook）
│  ├─ use-chapters.ts                    # 章节 CRUD + 拖拽排序
│  ├─ use-characters.ts                  # 人物 CRUD + 关系
│  ├─ use-worldview.ts                   # 世界观 CRUD（tree）
│  ├─ use-chat-sessions.ts               # 会话 CRUD
│  ├─ use-chat-messages.ts               # 消息查询 + 流式订阅
│  ├─ use-rag.ts                         # 文档 CRUD + 检索
│  └─ use-settings.ts                    # 项目/全局设置 + API Key
│
├─ components/
│  ├─ project/                           [Task 1 新增]
│  │  ├─ ProjectCard.tsx                 # 项目卡片
│  │  ├─ ProjectCreateDialog.tsx         # 新建项目对话框
│  │  └─ ProjectListEmpty.tsx            # 空状态
│  │
│  ├─ chapter/                           [Task 2 新增]
│  │  ├─ ChapterList.tsx                 # 章节列表（侧边栏）
│  │  ├─ ChapterEditor.tsx               # TipTap 3 编辑器
│  │  ├─ ChapterToolbar.tsx              # 章节工具栏（状态切换）
│  │  └─ ChapterCreateDialog.tsx         # 新建章节对话框
│  │
│  ├─ character/                         [Task 3 新增]
│  │  ├─ CharacterCard.tsx               # 人物卡片
│  │  ├─ CharacterFormDialog.tsx         # 人物表单对话框
│  │  └─ CharacterRelationGraph.tsx     # ReactFlow 关系图
│  │
│  ├─ worldview/                         [Task 4 新增]
│  │  ├─ WorldviewTree.tsx               # 递归树形视图
│  │  ├─ WorldviewTreeNode.tsx           # 单个节点
│  │  └─ WorldviewEditor.tsx             # 节点编辑面板
│  │
│  ├─ chat/                              [Task 5 新增]
│  │  ├─ ChatSessionList.tsx             # 会话列表
│  │  ├─ ChatMessageList.tsx             # 消息流（含流式 chunk）
│  │  ├─ ChatMessageBubble.tsx           # 单条消息气泡
│  │  └─ ChatInputArea.tsx               # 输入框 + 发送 + 停止
│  │
│  ├─ rag/                               [Task 6 新增]
│  │  ├─ RagDocumentList.tsx             # 文档列表
│  │  ├─ RagUploadDialog.tsx             # 文件上传对话框
│  │  └─ RagSearchTestPanel.tsx          # 检索测试面板
│  │
│  ├─ settings/                          [Task 7 新增]
│  │  ├─ ApiKeySection.tsx               # DeepSeek API Key 设置
│  │  ├─ OllamaConfigSection.tsx         # Ollama 配置
│  │  ├─ AiParamsSection.tsx             # AI 模型参数
│  │  └─ ProjectSettingsLink.tsx         # 项目级设置入口
│  │
│  └─ common/                            [Task 1 新增]
│     ├─ EmptyState.tsx                  # 通用空状态
│     ├─ ConfirmDialog.tsx               # 通用确认对话框
│     ├─ LoadingSpinner.tsx              # 加载中骨架
│     └─ ErrorState.tsx                  # 通用错误状态
│
├─ routes/                               [Task 1-7 替换]
│  ├─ root.tsx                           [修改] Task 7：errorElement 接入 useNavigate
│  ├─ projects.tsx                       [替换] Task 1：ProjectListPage
│  ├─ project-shell.tsx                  [修改] Task 2：加载项目详情到 store
│  ├─ chapters.tsx                       [替换] Task 2：ChapterWorkspace
│  ├─ characters.tsx                     [替换] Task 3：CharacterWorkspace
│  ├─ worldview.tsx                      [替换] Task 4：WorldviewWorkspace
│  ├─ chat.tsx                           [替换] Task 5：ChatWorkspace
│  ├─ rag.tsx                            [替换] Task 6：RagWorkspace
│  └─ settings.tsx                       [替换] Task 7：SettingsPage
│
├─ lib/
│  └─ format.ts                          [Task 1 新增] 时间/字数格式化工具
│
└─ types/
   └─ rag.d.ts                           [Task 6 新增] 文件上传类型补充
```

---

## 4. Task 清单

### Task 1: 项目列表页 + 通用组件 + 8 个领域 hooks

**Files:**
- Create: `src/renderer/hooks/use-projects.ts` / `use-chapters.ts` / `use-characters.ts` / `use-worldview.ts` / `use-chat-sessions.ts` / `use-chat-messages.ts` / `use-rag.ts` / `use-settings.ts`
- Create: `src/renderer/components/common/EmptyState.tsx` / `ConfirmDialog.tsx` / `LoadingSpinner.tsx` / `ErrorState.tsx`
- Create: `src/renderer/components/project/ProjectCard.tsx` / `ProjectCreateDialog.tsx` / `ProjectListEmpty.tsx`
- Create: `src/renderer/lib/format.ts`
- Replace: `src/renderer/routes/projects.tsx`

#### 1.1 8 个领域 hooks

每个 hook 文件按业务域封装 useIpcQuery + useIpcMutation，统一管理 queryKey 失效。

```ts
// use-projects.ts
export function useProjectList(): UseQueryResult<Project[], Error> {
  return useIpcQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: () => apiClient.project.list(),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useIpcMutation({
    mutationFn: (input: ProjectCreateInput) => apiClient.project.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
  });
}

// 同理 useArchiveProject / useDeleteProject / useUpdateProject
```

#### 1.2 项目列表页布局

```
┌─────────────────────────────────────────────────────┐
│  项目列表                          [+ 新建项目]    │
├─────────────────────────────────────────────────────┤
│  [搜索框]                                            │
├─────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │ 项目卡片 │  │ 项目卡片 │  │ 项目卡片 │            │
│  └─────────┘  └─────────┘  └─────────┘            │
└─────────────────────────────────────────────────────┘
```

- 空状态：ProjectListEmpty（引导新建第一个项目）
- 加载中：LoadingSpinner
- 错误：ErrorState（含重试按钮）
- 卡片：标题、流派、状态徽章、更新时间、归档/删除菜单

### Task 2: 章节管理页（TipTap 3 编辑器）

**Files:**
- Modify: `package.json`（新增 @tiptap/* 依赖）
- Create: `src/renderer/components/chapter/ChapterList.tsx` / `ChapterEditor.tsx` / `ChapterToolbar.tsx` / `ChapterCreateDialog.tsx`
- Replace: `src/renderer/routes/chapters.tsx`
- Modify: `src/renderer/routes/project-shell.tsx`（加载项目详情 + setActiveProject）

#### 2.1 依赖安装

```bash
pnpm add @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder @tiptap/extension-character-count
```

#### 2.2 章节工作台布局

```
┌──────────────┬───────────────────────────────┐
│ 章节列表      │ ChapterToolbar（状态/字数）    │
│ ┌──────────┐ ├───────────────────────────────┤
│ │ 第1章    │ │                               │
│ │ 第2章 ●  │ │   TipTap 3 编辑器              │
│ │ 第3章    │ │                               │
│ └──────────┘ │                               │
│ [+ 新建]     │                               │
└──────────────┴───────────────────────────────┘
```

- 章节列表：可拖拽排序（HTML5 DnD，调 chapter:reorder）
- 编辑器：TipTap 3 StarterKit + Placeholder（"开始写作..."）+ CharacterCount（字数统计）
- 自动保存：useDebounce 1.5s 后调 chapter:update（content + wordCount）

### Task 3: 人物卡页（卡片网格 + ReactFlow 关系图）

**Files:**
- Modify: `package.json`（新增 @xyflow/react）
- Create: `src/renderer/components/character/CharacterCard.tsx` / `CharacterFormDialog.tsx` / `CharacterRelationGraph.tsx`
- Replace: `src/renderer/routes/characters.tsx`

#### 3.1 依赖安装

```bash
pnpm add @xyflow/react
```

#### 3.2 人物工作台布局

```
┌──────────────────────┬──────────────────────────┐
│ 人物卡片网格          │ ReactFlow 关系图          │
│ ┌────┐ ┌────┐ ┌────┐ │     [主角]               │
│ │角色1│ │角色2│ │角色3│ │       \                  │
│ └────┘ └────┘ └────┘ │       [反派]              │
│ [+ 新建人物]         │                           │
└──────────────────────┴──────────────────────────┘
```

- 卡片：头像、姓名、角色徽章（主角/反派/配角/龙套）、描述摘要
- 表单对话框：姓名/角色/头像 URL/描述/profile（JSON 编辑器）
- 关系图：ReactFlow，节点为 Character，边为 CharacterRelation（带 type label）
- 添加关系：右键节点 → 选择目标 → 输入 type → 调 character:addRelation

### Task 4: 世界观页（递归树形视图）

**Files:**
- Create: `src/renderer/components/worldview/WorldviewTree.tsx` / `WorldviewTreeNode.tsx` / `WorldviewEditor.tsx`
- Replace: `src/renderer/routes/worldview.tsx`

#### 4.1 世界观工作台布局

```
┌──────────────────────┬──────────────────────────┐
│ WorldviewTree         │ WorldviewEditor           │
│ ▼ 大陆                │ 标题：[输入框]            │
│   ▼ 国家              │ 类型：[输入框]            │
│     • 城市1           │ 图标：[输入框]            │
│     • 城市2           │ 内容：[Textarea]          │
│   ▼ 组织              │                           │
│ [+ 新建根节点]         │ [保存] [删除]            │
└──────────────────────┴──────────────────────────┘
```

- 递归组件：WorldviewTreeNode 接收 node + children 数组，自递归渲染
- 节点选中：高亮 + 加载到 WorldviewEditor
- 添加子节点：右键节点 → 新建子节点对话框

### Task 5: AI 对话页（流式消息）

**Files:**
- Create: `src/renderer/components/chat/ChatSessionList.tsx` / `ChatMessageList.tsx` / `ChatMessageBubble.tsx` / `ChatInputArea.tsx`
- Replace: `src/renderer/routes/chat.tsx`

#### 5.1 对话工作台布局

```
┌──────────────┬───────────────────────────────────┐
│ 会话列表      │ ChatMessageList                    │
│ ┌──────────┐ │ ┌──────────────────────────────┐  │
│ │ 会话1    │ │ │ User: 你好                  │  │
│ │ 会话2 ●  │ │ │ Assistant: 你好，我是...    │  │
│ │ 会话3    │ │ └──────────────────────────────┘  │
│ └──────────┘ │                                     │
│ [+ 新建会话] │ ChatInputArea [输入] [发送] [停止]   │
└──────────────┴───────────────────────────────────┘
```

- 会话列表：调 chat:listSessions，点击切换 activeSessionId
- 消息流：调 chat:getMessages 一次性加载历史 + 订阅 onStreamChunk 累积到 chat-stream.store
- 输入框：Shift+Enter 换行，Enter 发送
- 停止按钮：调 chat:stopGeneration，仅在 status=streaming 时显示
- 错误处理：onStreamError → chat-stream.store.errorStream + toast

### Task 6: RAG 文档页（文件上传 + 检索测试）

**Files:**
- Create: `src/renderer/components/rag/RagDocumentList.tsx` / `RagUploadDialog.tsx` / `RagSearchTestPanel.tsx`
- Replace: `src/renderer/routes/rag.tsx`
- Create: `src/renderer/types/rag.d.ts`

#### 6.1 RAG 工作台布局

```
┌──────────────────────┬──────────────────────────┐
│ RagDocumentList       │ RagSearchTestPanel        │
│ ┌──────────────────┐ │ 查询：[输入框]            │
│ │ 文档1.pdf 12切片│ │ topK：[5]  threshold：[0.7]│
│ │ 文档2.md  8切片 │ │ [搜索]                   │
│ │ 文档3.txt 5切片 │ │                           │
│ └──────────────────┘ │ 结果：                    │
│ [+ 上传文档]         │ - 切片1 (score: 0.91)     │
│                      │ - 切片2 (score: 0.85)     │
└──────────────────────┴──────────────────────────┘
```

- 文件上传：FileReader.readAsText → RagIngestDocumentInput.fileContent 字符串传输
- 仅支持 .md / .txt / .json（PDF 解析需额外依赖，留待 Phase 9 增强）
- 检索测试：输入查询 → 调 rag:search → 展示结果列表

### Task 7: 设置页 + 错误处理集成

**Files:**
- Create: `src/renderer/components/settings/ApiKeySection.tsx` / `OllamaConfigSection.tsx` / `AiParamsSection.tsx` / `ProjectSettingsLink.tsx`
- Replace: `src/renderer/routes/settings.tsx`
- Modify: `src/renderer/routes/root.tsx`（errorElement 接入 RouterProvider navigate）
- Modify: `src/renderer/lib/handle-ipc-error.ts`（getErrorAction 改为返回 url，由调用方跳转）

#### 7.1 设置页布局

```
┌──────────────────────────────────────────────────┐
│ 应用设置                                          │
├──────────────────────────────────────────────────┤
│ ▼ API Key                                         │
│   DeepSeek API Key: [********] [测试] [保存]     │
├──────────────────────────────────────────────────┤
│ ▼ Ollama 配置                                    │
│   状态：运行中 ✓                                  │
│   嵌入模型：bge-m3 [下载]                         │
├──────────────────────────────────────────────────┤
│ ▼ AI 模型参数（项目级）                            │
│   选择项目：[下拉框]                              │
│   模型：[deepseek-chat]                          │
│   temperature：[1.0] ─────●──────                │
│   max_tokens：[4096]                             │
├──────────────────────────────────────────────────┤
│ ▼ RAG 配置                                       │
│   启用 RAG：[✓]                                   │
│   topK：[5]   threshold：[0.7]                   │
└──────────────────────────────────────────────────┘
```

- API Key：调 settings:setApiKey（keychain 存储）+ testApiKey 测试连通性
- Ollama 配置：只读展示状态（订阅 app-status.store），下载按钮调 ollama 拉取模型（通过 IPC 触发主进程，进度已在 StatusBar 显示）
- AI 模型参数：调 settings:get / settings:set（按 projectId）
- RAG 配置：同 settings:set

#### 7.2 错误处理集成

`handle-ipc-error.ts` 的 `getErrorAction` 改为返回 `{ label, to: string }`（路由路径），调用方在组件层用 useNavigate 跳转。

---

## 5. 关键设计决策

### 5.1 领域 hooks 封装

- **原因**：组件直接调 apiClient 会导致 queryKey 失效逻辑散落在各组件，难以维护
- **方案**：每个业务域 1 个 hook 文件，封装 query + mutation + invalidate 逻辑
- **优点**：组件只需 `const { data, mutate } = useProjectList()`，业务逻辑集中

### 5.2 TipTap 3 vs ProseMirror / Slate

- **选 TipTap 3**：基于 ProseMirror 的封装，API 友好；React 19.2 兼容；社区活跃
- **替代方案**：Slate（更灵活但配置复杂）、Lexical（Facebook 出品但生态较新）
- **决策依据**：设计文档 §2.3 已指定 TipTap 3

### 5.3 ReactFlow（@xyflow/react）vs 自实现 SVG/Canvas

- **选 ReactFlow**：开箱即用拖拽/缩放/连线，性能足够（节点 ≤ 100 个）
- **替代方案**：d3-force + SVG（自实现工作量大）、Cytoscape.js（功能更强但体积大）
- **决策依据**：设计文档 §6.3 已指定 ReactFlow

### 5.4 章节自动保存策略

- **方案**：useDebounce 1.5s 后调 chapter:update（content + wordCount）
- **不立即保存的原因**：每次按键都触发 IPC 会拖慢主进程
- **替代方案**：手动保存按钮（用户体验差）、Redux + diff 保存（过度工程化）
- **失败处理**：toast 提示 + 保留编辑器内容（用户可重试）

### 5.5 聊天流式订阅生命周期

- **方案**：ChatMessageList 在 useEffect 中订阅 onStreamChunk/onStreamEnd/onStreamError
- **生命周期**：组件 mount 时订阅，unmount 时 cleanup（避免内存泄漏）
- **sessionId 切换**：useEffect 依赖 sessionId，切换时重新订阅

### 5.6 RAG 文件传输：字符串 vs 二进制

- **选字符串**：IPC 不支持二进制流传输，FileReader.readAsText 转字符串后通过 fileContent 字段传输
- **限制**：仅支持文本格式（.md/.txt/.json），PDF 需要主进程侧解析
- **Phase 9 增强**：如需 PDF 支持，在主进程引入 pdf-parse，IPC 接收文件路径由主进程读取

### 5.7 设置页错误处理：路由跳转

- **方案**：handle-ipc-error getErrorAction 返回 `{ label, to: string }`，调用方在组件层用 useNavigate 跳转
- **替代方案**：handleIpcError 内部直接调 window.history.pushState（绕过 RR7，会破坏路由状态一致性）
- **决策依据**：RR7 推荐通过 RouterProvider 提供的 navigate 跳转

### 5.8 项目级 vs 全局设置区分

- **全局设置**：DeepSeek API Key（keychain 存储，跨项目共享）
- **项目级设置**：AI 模型参数 + RAG 配置（按 projectId 隔离）
- **UI 设计**：设置页用 Tabs 区分"全局"和"项目级"两个 Tab

### 5.9 不引入国际化（i18n）

- **原因**：用户群为中文网文写作者，UI 文本硬编码中文即可
- **替代方案**：react-i18next（Phase 10 视需求引入）

### 5.10 不引入复杂表单库

- **原因**：表单字段较少（项目/章节/人物/世界观），直接 useState + Zod 校验足够
- **替代方案**：react-hook-form（Phase 9 视需要引入，目前过度工程化）

---

## 6. 执行策略

### 6.1 串行 + 并行混合

```
Task 1（主代理 + 子代理并行）
  ├─ 主代理：8 个领域 hooks + 4 个通用组件 + format.ts
  └─ 子代理：项目列表页（3 个项目组件 + projects.tsx 替换）

Task 2-7（6 个子代理并行）
  ├─ Task 2：章节管理页（TipTap 3）
  ├─ Task 3：人物卡页（ReactFlow）
  ├─ Task 4：世界观页（递归树）
  ├─ Task 5：AI 对话页（流式）
  ├─ Task 6：RAG 文档页（上传 + 检索）
  └─ Task 7：设置页 + 错误处理集成
```

### 6.2 子代理边界

- **Task 1 子代理**：仅创建项目列表页（3 个组件 + 1 个路由替换），依赖主代理已完成的 hooks
- **Task 2-7 子代理**：各自独立的业务域目录（components/{chapter,character,worldview,chat,rag,settings}/），无文件冲突
- **共享依赖**：所有子代理共享 hooks/ 与 components/common/，由 Task 1 主代理先完成

### 6.3 提交策略

按 Task 粒度提交（用户规则：每轮对话只要有代码修改过就 git 提交一次 + codegraph sync）：

1. `feat(renderer): 8 个领域 hooks + 4 个通用组件 + 项目列表页`（Task 1）
2. `feat(renderer): 章节管理页 + TipTap 3 编辑器`（Task 2）
3. `feat(renderer): 人物卡页 + ReactFlow 关系图`（Task 3）
4. `feat(renderer): 世界观页 + 递归树形视图`（Task 4）
5. `feat(renderer): AI 对话页 + 流式消息订阅`（Task 5）
6. `feat(renderer): RAG 文档页 + 文件上传 + 检索测试`（Task 6）
7. `feat(renderer): 设置页 + 错误处理路由跳转集成`（Task 7）

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| TipTap 3 与 React 19.2 兼容性 | 已确认 TipTap 3 支持 React 19；若失败回退 Slate |
| ReactFlow 体积大（~200KB） | 用 lazy 加载，仅在 characters 路由动态导入 |
| 章节自动保存丢失内容 | 失败时保留编辑器内容 + toast 提示，不切换章节直到成功 |
| 聊天流式 chunk 高频更新导致重渲染 | chat-stream.store 按 sessionId 累积，组件用 selector 订阅单 session |
| RAG 大文件传输超过 IPC 限制 | 限制单文件 10MB，超限提示用户拆分；Phase 9 考虑分片上传 |
| 设置页表单状态复杂 | 拆分为 ApiKeySection/OllamaConfigSection/AiParamsSection 三个子组件，各自管理状态 |
| 9 个路由同时替换可能引入回归 | 按 Task 串行提交，每个 Task 跑 pnpm test 验证 |
| handle-ipc-error 改动影响范围 | 修改 getErrorAction 返回类型为 `{ label, to: string }`，所有调用方需同步更新 |

---

## 8. 验收清单

- [ ] `pnpm install` 无错误（新增 TipTap 3 + ReactFlow 依赖）
- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors（含新增 30+ 文件）
- [ ] `pnpm build` 三入口产物生成
- [ ] `pnpm dev` 启动后：
  - [ ] /projects 显示项目列表（含空状态）
  - [ ] /projects/:projectId/chapters 显示章节列表 + 编辑器
  - [ ] /projects/:projectId/characters 显示人物卡片 + 关系图
  - [ ] /projects/:projectId/worldview 显示树形视图
  - [ ] /projects/:projectId/chat 显示会话列表 + 消息流
  - [ ] /projects/:projectId/rag 显示文档列表 + 上传/检索面板
  - [ ] /settings 显示 API Key/Ollama/AI 参数三个区块
- [ ] `pnpm test` 通过（Phase 7 的 254 测试不被破坏）
- [ ] `codegraph sync` 成功
- [ ] 7 个 git commit（按 Task 粒度）
